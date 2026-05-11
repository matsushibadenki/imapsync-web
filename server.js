/*
 * Path: /imapsync-web/server.js
 * Title: Imapsync Node.js GUI Server
 * Purpose: Provides a local web server backend for imapsync. It executes the
 *          imapsync command-line tool as a child process and streams output to
 *          the frontend via Server-Sent Events (SSE).
 */
const express = require('express');
const { spawn } = require('child_process');
const net = require('net');
const tls = require('tls');
const path = require('path');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '64kb' }));

let currentProcess = null;
let startedAt = null;
let lastExitCode = null;
let lastCommandPreview = '';
let logBuffer = [];
let clients = [];

const DEFAULT_PORTS = {
    ssl: 993,
    starttls: 143,
    plain: 143
};

const BOOLEAN_OPTIONS = [
    ['dryRun', '--dry'],
    ['syncDeletes', '--delete2'],
    ['subscribeFolders', '--subscribe'],
    ['automapFolders', '--automap'],
    ['useUid', '--useuid'],
    ['fastMode', '--fast']
];

function cleanString(value) {
    return String(value || '').trim();
}

function cleanPort(value, fallback) {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return port;
    }
    return fallback;
}

function requireField(body, key, label) {
    const value = cleanString(body[key]);
    if (!value) {
        const error = new Error(`${label} is required`);
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function tokenizeArgs(input) {
    const text = cleanString(input);
    if (!text) return [];

    const tokens = [];
    let current = '';
    let quote = null;
    let escaping = false;

    for (const char of text) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === '\\') {
            escaping = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }

    if (quote) {
        const error = new Error('Advanced arguments contain an unclosed quote');
        error.statusCode = 400;
        throw error;
    }
    if (escaping) current += '\\';
    if (current) tokens.push(current);

    return tokens;
}

function redactArgs(args) {
    return args.map((arg, index) => {
        const previous = args[index - 1];
        if (previous === '--password1' || previous === '--password2') {
            return '••••••••';
        }
        return /\s/.test(arg) ? JSON.stringify(arg) : arg;
    }).join(' ');
}

function buildImapsyncArgs(body, { redact = false } = {}) {
    const security1 = cleanString(body.security1) || 'ssl';
    const security2 = cleanString(body.security2) || 'ssl';
    const port1 = cleanPort(body.port1, DEFAULT_PORTS[security1] || 993);
    const port2 = cleanPort(body.port2, DEFAULT_PORTS[security2] || 993);

    const args = [
        '--host1', requireField(body, 'host1', 'Source host'),
        '--port1', String(port1),
        '--user1', requireField(body, 'user1', 'Source user'),
        '--password1', requireField(body, 'pass1', 'Source password'),
        '--host2', requireField(body, 'host2', 'Destination host'),
        '--port2', String(port2),
        '--user2', requireField(body, 'user2', 'Destination user'),
        '--password2', requireField(body, 'pass2', 'Destination password')
    ];

    if (security1 === 'ssl') args.push('--ssl1');
    if (security2 === 'ssl') args.push('--ssl2');
    if (security1 === 'starttls') args.push('--tls1');
    if (security2 === 'starttls') args.push('--tls2');

    BOOLEAN_OPTIONS.forEach(([key, flag]) => {
        if (body[key]) args.push(flag);
    });

    const maxAge = Number(body.maxAgeDays);
    if (Number.isInteger(maxAge) && maxAge > 0) args.push('--maxage', String(maxAge));

    const minAge = Number(body.minAgeDays);
    if (Number.isInteger(minAge) && minAge > 0) args.push('--minage', String(minAge));

    const bandwidth = Number(body.bandwidthKb);
    if (Number.isInteger(bandwidth) && bandwidth > 0) args.push('--maxbytespersecond', String(bandwidth * 1024));

    const providerSafeMode = Boolean(body.providerSafeMode);
    const safeNumber = (value, fallback, parser = Number) => {
        const parsed = parser(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        return providerSafeMode ? fallback : null;
    };

    const maxMessagesPerSecond = safeNumber(body.maxMessagesPerSecond, 0.5);
    if (maxMessagesPerSecond) args.push('--maxmessagespersecond', String(maxMessagesPerSecond));

    const maxSleepSeconds = safeNumber(body.maxSleepSeconds, 8);
    if (maxSleepSeconds) args.push('--maxsleep', String(maxSleepSeconds));

    const maxBytesAfterMb = safeNumber(body.maxBytesAfterMb, 50, Number.parseFloat);
    if (maxBytesAfterMb) args.push('--maxbytesafter', String(Math.round(maxBytesAfterMb * 1024 * 1024)));

    const stopAfterMb = safeNumber(body.stopAfterMb, null, Number.parseFloat);
    if (stopAfterMb) args.push('--exitwhenover', String(Math.round(stopAfterMb * 1024 * 1024)));

    const errorsMax = safeNumber(body.errorsMax, 10, Number.parseInt);
    if (errorsMax) args.push('--errorsmax', String(errorsMax));

    const timeoutSeconds = safeNumber(body.timeoutSeconds, 180, Number.parseFloat);
    if (timeoutSeconds) args.push('--timeout1', String(timeoutSeconds), '--timeout2', String(timeoutSeconds));

    cleanString(body.excludePattern)
        .split(/\r?\n|\\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .forEach(pattern => args.push('--exclude', pattern));

    args.push(...tokenizeArgs(body.advancedArgs));

    return redact ? redactArgs(args) : args;
}

function broadcastLog(message, level = 'info') {
    const entry = {
        time: new Date().toISOString(),
        level,
        message: String(message).replace(/\r/g, '').trimEnd()
    };
    logBuffer.push(entry);
    if (logBuffer.length > 1200) logBuffer = logBuffer.slice(-1200);
    clients.forEach(client => client.write(`data: ${JSON.stringify(entry)}\n\n`));
}

function getStatus() {
    return {
        running: Boolean(currentProcess),
        startedAt,
        lastExitCode,
        commandPreview: lastCommandPreview,
        logCount: logBuffer.length
    };
}

app.get('/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    logBuffer.forEach(log => res.write(`data: ${JSON.stringify(log)}\n\n`));
    clients.push(res);

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

app.post('/api/preview', (req, res) => {
    try {
        const commandPreview = `imapsync ${buildImapsyncArgs(req.body, { redact: true })}`;
        res.json({ commandPreview });
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

app.post('/api/test-connection', (req, res) => {
    const host = cleanString(req.body.host);
    const security = cleanString(req.body.security) || 'ssl';
    const port = cleanPort(req.body.port, DEFAULT_PORTS[security] || 993);

    if (!host) {
        return res.status(400).json({ error: 'Host is required' });
    }

    const started = Date.now();
    const done = (socket, ok, detail) => {
        socket?.destroy();
        res.status(ok ? 200 : 502).json({
            ok,
            detail,
            latencyMs: Date.now() - started,
            endpoint: `${host}:${port}`
        });
    };

    const socket = security === 'ssl'
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });

    socket.setTimeout(8000);
    socket.once('connect', () => done(socket, true, 'TCP connection established'));
    socket.once('secureConnect', () => done(socket, true, 'TLS connection established'));
    socket.once('timeout', () => done(socket, false, 'Connection timed out'));
    socket.once('error', error => done(socket, false, error.message));
});

app.post('/api/sync', (req, res) => {
    if (currentProcess) {
        return res.status(409).json({ error: 'Sync already in progress' });
    }

    let args;
    try {
        args = buildImapsyncArgs(req.body);
        lastCommandPreview = `imapsync ${redactArgs(args)}`;
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    logBuffer = [];
    startedAt = new Date().toISOString();
    lastExitCode = null;
    broadcastLog('--- Sync started ---');
    broadcastLog(lastCommandPreview, 'command');

    currentProcess = spawn('imapsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    currentProcess.stdout.on('data', data => {
        broadcastLog(data.toString(), 'info');
    });

    currentProcess.stderr.on('data', data => {
        broadcastLog(data.toString(), 'error');
    });

    currentProcess.on('error', error => {
        broadcastLog(`Failed to start imapsync: ${error.message}`, 'error');
        currentProcess = null;
        lastExitCode = -1;
    });

    currentProcess.on('close', code => {
        lastExitCode = code;
        broadcastLog(`--- Sync finished with exit code ${code} ---`, code === 0 ? 'success' : 'error');
        currentProcess = null;
    });

    res.json({ message: 'Sync process started', status: getStatus() });
});

app.post('/api/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill('SIGTERM');
        currentProcess = null;
        lastExitCode = null;
        broadcastLog('--- Sync process terminated by user ---', 'warning');
        return res.json({ message: 'Process stopped', status: getStatus() });
    }
    res.status(400).json({ error: 'No process running' });
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
    currentProcess?.kill('SIGTERM');
    server.close(() => process.exit(0));
});
