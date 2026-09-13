import { exec } from 'node:child_process';
import dns from 'node:dns';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { GatewayEvents } from '../constants.js';
import { http1makeRequest, logger } from '../utils.js';
const execAsync = promisify(exec);
const dnsLookup = promisify(dns.lookup);
const DEFAULT_TEST_ENDPOINTS = [
    {
        name: 'Cachefly',
        url: 'http://cachefly.cachefly.net/10mb.test',
        expectedSizeBytes: 10 * 1024 * 1024
    },
    {
        name: 'Cloudflare',
        url: 'https://speed.cloudflare.com/__down?bytes=10485760',
        expectedSizeBytes: 10 * 1024 * 1024
    },
    {
        name: 'ThinkBroadband',
        url: 'http://ipv4.download.thinkbroadband.com/10MB.zip',
        expectedSizeBytes: 10 * 1024 * 1024
    },
    {
        name: 'Speedtest (Otenet)',
        url: 'http://speedtest.ftp.otenet.gr/files/test10Mb.db',
        expectedSizeBytes: 10 * 1024 * 1024
    },
    {
        name: 'Proof',
        url: 'http://proof.ovh.net/files/10Mb.dat',
        expectedSizeBytes: 10 * 1024 * 1024
    }
];
const DEFAULT_DNS_HOSTS = ['google.com', 'cloudflare.com', '8.8.8.8'];
const DEFAULT_PING_HOSTS = ['1.1.1.1', '8.8.8.8', 'cloudflare.com'];
/**
 * Monitors network connectivity and publishes connection metrics.
 * @remarks Uses HTTP downloads, DNS lookups, and optional ping checks to
 * classify connection quality.
 * @public
 */
export default class ConnectionManager {
    nodelink;
    config;
    interval;
    status;
    metrics;
    isChecking;
    _networkCache;
    _lastSpeedTestTime;
    _lastPingMs;
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config =
            nodelink.options.network?.connection || nodelink.options.connection || {};
        this.interval = null;
        this.status = 'unknown';
        this.metrics = { timestamp: Date.now() };
        this.isChecking = false;
        this._networkCache = null;
        this._lastSpeedTestTime = 0;
        this._lastPingMs = undefined;
    }
    start() {
        const checkInterval = Math.max(1, this.config.interval || 300000);
        if (checkInterval > 0) {
            logger('info', 'ConnectionManager', `Starting connection checks every ${checkInterval}ms.`);
            // Delay the first check so it doesn't feel like part of the startup latency
            setTimeout(() => {
                this.checkConnection().catch(() => { });
            }, 5000);
            this.interval = setInterval(() => this.checkConnection().catch(() => { }), checkInterval);
        }
    }
    /**
     * Stops the periodic connection monitor.
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    /**
     * Stops the monitor and releases resources.
     */
    destroy() {
        this.stop();
    }
    /**
     * Runs a full connectivity check and updates metrics.
     */
    async checkConnection() {
        if (this.isChecking)
            return;
        this.isChecking = true;
        const now = Date.now();
        const dnsResult = await this._testDnsConnectivity();
        const pingResult = await this._testPing();
        const networkInfo = await this._getNetworkInfo();
        const currentPing = pingResult?.avgMs;
        let shouldRunSpeedTest = false;
        /**
         * Determine if a speed test should be performed:
         * 1. Initial run
         * 2. 25 minutes (1,500,000ms) since the last test
         * 3. Drastic ping change (>50% increase or >100ms increase)
         */
        if (this._lastSpeedTestTime === 0 ||
            now - this._lastSpeedTestTime > 1500000) {
            shouldRunSpeedTest = true;
        }
        else if (currentPing !== undefined && this._lastPingMs !== undefined) {
            const pingDiff = currentPing - this._lastPingMs;
            if (currentPing > this._lastPingMs * 1.5 || pingDiff > 100) {
                shouldRunSpeedTest = true;
                logger('debug', 'ConnectionManager', `Ping instability detected (${this._lastPingMs}ms -> ${currentPing}ms). Triggering immediate speed test.`);
            }
        }
        this._lastPingMs = currentPing;
        if (shouldRunSpeedTest) {
            const endpoints = this._getEndpoints();
            for (const endpoint of endpoints) {
                try {
                    const result = await this._runSpeedTest(endpoint);
                    if (!result)
                        continue;
                    const { speedMbps, downloadedBytes, durationSeconds, latencyMs } = result;
                    const newStatus = this._classifyStatus(speedMbps);
                    this.metrics = {
                        speed: {
                            bps: result.speedBps,
                            kbps: result.speedKbps,
                            mbps: Number.parseFloat(speedMbps.toFixed(2))
                        },
                        downloadedBytes,
                        durationSeconds: Number.parseFloat(durationSeconds.toFixed(2)),
                        latencyMs,
                        endpoint,
                        dns: dnsResult,
                        ping: pingResult,
                        network: networkInfo,
                        timestamp: now
                    };
                    this._lastSpeedTestTime = now;
                    this._updateStatusAndLog(newStatus);
                    this.isChecking = false;
                    return;
                }
                catch (_error) { }
            }
        }
        else {
            this.metrics = {
                ...this.metrics,
                dns: dnsResult,
                ping: pingResult,
                network: networkInfo,
                timestamp: now
            };
            this.broadcastStatus();
        }
        this.isChecking = false;
        if (this._lastSpeedTestTime === 0 && this.status !== 'disconnected') {
            this.status = 'disconnected';
            this.metrics = {
                dns: dnsResult,
                ping: pingResult,
                network: networkInfo,
                error: 'All connection tests failed',
                timestamp: now
            };
            this.broadcastStatus();
        }
    }
    _updateStatusAndLog(newStatus) {
        const shouldLog = this.config.logAllChecks || newStatus !== this.status;
        if (shouldLog) {
            const logSummary = this._formatLogSummary(newStatus);
            if (newStatus === 'bad') {
                logger('warn', 'Network', `Connection is very slow (${this.metrics.speed?.mbps} Mbps). ${logSummary}`);
            }
            else {
                logger('network', 'ConnectionManager', `Connection speed: ${this.metrics.speed?.mbps} Mbps (${newStatus}). ${logSummary}`);
            }
        }
        if (newStatus !== this.status || this.config.logAllChecks) {
            this.status = newStatus;
            this.broadcastStatus();
        }
    }
    /**
     * Publishes the current connection status to all sessions.
     */
    broadcastStatus() {
        const payload = {
            op: 'event',
            type: GatewayEvents.CONNECTION_STATUS,
            guildId: '',
            status: this.status,
            metrics: this.metrics
        };
        if (this.nodelink.sessions?.values) {
            for (const session of this.nodelink.sessions.values()) {
                const player = session.players.players.values().next().value;
                if (!player)
                    continue;
                payload.guildId = player.guildId;
                session.socket?.send(JSON.stringify(payload));
            }
        }
    }
    _getEndpoints() {
        return this.config.testEndpoints?.length
            ? this.config.testEndpoints
            : DEFAULT_TEST_ENDPOINTS;
    }
    _classifyStatus(speedMbps) {
        if (speedMbps < (this.config.thresholds?.bad ?? 1))
            return 'bad';
        if (speedMbps < (this.config.thresholds?.average ?? 5))
            return 'average';
        return 'good';
    }
    _formatLogSummary(status) {
        const endpoint = this.metrics.endpoint?.name ?? 'unknown';
        const speed = this.metrics.speed?.mbps !== undefined
            ? `${this.metrics.speed.mbps} Mbps`
            : 'n/a';
        const latency = this.metrics.latencyMs !== undefined
            ? `${Math.round(this.metrics.latencyMs)}ms`
            : 'n/a';
        const dnsSummary = this.metrics.dns
            ? this.metrics.dns.isOnline
                ? `DNS lookup (name resolution) is online via ${this.metrics.dns.host ?? 'unknown'} in ${Math.round(this.metrics.dns.latencyMs ?? 0)}ms.`
                : 'DNS lookup failed (name resolution appears offline).'
            : 'DNS status unavailable.';
        const pingSummary = this.metrics.ping
            ? this.metrics.ping.alive
                ? `Ping (round-trip latency) to ${this.metrics.ping.host} averages ${Math.round(this.metrics.ping.avgMs ?? 0)}ms with ${this.metrics.ping.packetLoss ?? 0}% packet loss.`
                : `Ping (round-trip latency) to ${this.metrics.ping.host} failed.`
            : 'Ping data unavailable.';
        const network = this.metrics.network
            ? this.metrics.network.isConnected
                ? `Network connection: ${this.metrics.network.connectionType === 'wifi'
                    ? 'Wi-Fi'
                    : this.metrics.network.connectionType === 'ethernet'
                        ? 'Ethernet'
                        : this.metrics.network.connectionType === 'mobile'
                            ? 'Mobile'
                            : 'Unknown'}${this.metrics.network.wifiName
                    ? ` (SSID ${this.metrics.network.wifiName})`
                    : ''}${this.metrics.network.interfaceName
                    ? ` on interface ${this.metrics.network.interfaceName}`
                    : ''}${this.metrics.network.ipAddress
                    ? ` with IP ${this.metrics.network.ipAddress}`
                    : ''}${this.metrics.network.gateway ? `, gateway ${this.metrics.network.gateway}` : ''}${this.metrics.network.dnsServers?.length
                    ? `, DNS servers ${this.metrics.network.dnsServers.join(', ')}`
                    : ''}.`
                : 'Network connection: disconnected.'
            : 'Network details unavailable.';
        return `Status: ${status} (quality rating). Download speed: ${speed} from ${endpoint}. Time to first byte (TTFB, how fast the server starts sending data): ${latency}. ${dnsSummary} ${pingSummary} ${network}`;
    }
    async _runSpeedTest(endpoint) {
        const startTime = performance.now();
        let downloadedBytes = 0;
        let latencyMs;
        const maxBytes = this.config.maxDownloadBytes ?? endpoint.expectedSizeBytes;
        const maxDurationMs = this.config.maxTestDurationMs ?? this.config.timeout ?? 10000;
        const httpRequest = http1makeRequest;
        const { stream, error, statusCode } = await httpRequest(endpoint.url, {
            method: 'GET',
            streamOnly: true,
            timeout: this.config.timeout || 10000,
            headers: {
                'Accept-Encoding': 'identity'
            }
        }, this.nodelink);
        if (!stream || error || statusCode !== 200) {
            return null;
        }
        return await new Promise((resolve, reject) => {
            let settled = false;
            let aborted = false;
            const finalize = () => {
                if (settled)
                    return;
                settled = true;
                const durationSeconds = (performance.now() - startTime) / 1000;
                if (durationSeconds <= 0 || downloadedBytes <= 0) {
                    resolve(null);
                    return;
                }
                const speedBps = downloadedBytes / durationSeconds;
                const speedKbps = (speedBps * 8) / 1024;
                const speedMbps = speedKbps / 1024;
                resolve({
                    speedBps,
                    speedKbps,
                    speedMbps,
                    downloadedBytes,
                    durationSeconds,
                    latencyMs
                });
            };
            const timeoutTimer = setTimeout(() => {
                aborted = true;
                stream.destroy();
                finalize();
            }, maxDurationMs);
            stream.on('data', (chunk) => {
                if (latencyMs === undefined) {
                    latencyMs = performance.now() - startTime;
                }
                downloadedBytes += chunk.length;
                if (maxBytes && downloadedBytes >= maxBytes) {
                    aborted = true;
                    stream.destroy();
                    finalize();
                }
            });
            stream.on('end', () => {
                clearTimeout(timeoutTimer);
                finalize();
            });
            stream.on('close', () => {
                clearTimeout(timeoutTimer);
                if (aborted)
                    finalize();
            });
            stream.on('error', (err) => {
                clearTimeout(timeoutTimer);
                if (aborted)
                    return;
                reject(err);
            });
        });
    }
    async _testDnsConnectivity() {
        const hosts = this.config.dnsHosts?.length
            ? this.config.dnsHosts
            : DEFAULT_DNS_HOSTS;
        const timeoutMs = this.config.timeout ?? 10000;
        for (const host of hosts) {
            const startTime = performance.now();
            try {
                await Promise.race([
                    dnsLookup(host),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs))
                ]);
                return {
                    isOnline: true,
                    host,
                    latencyMs: performance.now() - startTime
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : 'DNS lookup failed';
                logger('debug', 'ConnectionManager', `DNS check failed for ${host}: ${message}`);
            }
        }
        return {
            isOnline: false,
            error: 'No DNS host responded'
        };
    }
    async _testPing() {
        const hosts = this.config.pingHosts?.length
            ? this.config.pingHosts
            : DEFAULT_PING_HOSTS;
        const timeoutMs = this.config.timeout ?? 5000;
        for (const host of hosts) {
            const result = await this._pingHost(host, timeoutMs);
            if (result.alive) {
                return result;
            }
        }
        return undefined;
    }
    async _pingHost(host, timeoutMs) {
        const platform = os.platform();
        const command = platform === 'win32'
            ? `ping -n 4 -w ${timeoutMs} ${host}`
            : `ping -c 4 -W ${Math.ceil(timeoutMs / 1000)} ${host}`;
        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: timeoutMs + 2000
            });
            if (stderr?.trim()) {
                return { host, alive: false, error: stderr.trim() };
            }
            return platform === 'win32'
                ? this._parseWindowsPing(host, stdout)
                : this._parseUnixPing(host, stdout);
        }
        catch (error) {
            return {
                host,
                alive: false,
                error: error instanceof Error ? error.message : 'Ping failed'
            };
        }
    }
    _parseWindowsPing(host, output) {
        const result = { host, alive: false };
        if (output.includes('Request timed out') ||
            output.includes('Destination host unreachable')) {
            return result;
        }
        const statsMatch = output.match(/Minimum = (\d+)ms, Maximum = (\d+)ms, Average = (\d+)ms/);
        if (statsMatch?.[1] && statsMatch?.[2] && statsMatch?.[3]) {
            result.alive = true;
            result.minMs = Number.parseFloat(statsMatch[1]);
            result.maxMs = Number.parseFloat(statsMatch[2]);
            result.avgMs = Number.parseFloat(statsMatch[3]);
        }
        const lossMatch = output.match(/(\d+)% loss/);
        if (lossMatch?.[1]) {
            result.packetLoss = Number.parseInt(lossMatch[1], 10);
        }
        return result;
    }
    _parseUnixPing(host, output) {
        const result = { host, alive: false };
        if (output.includes('100% packet loss') ||
            output.includes('Network is unreachable')) {
            return result;
        }
        const statsMatch = output.match(/(?:round-trip|rtt) min\/avg\/max\/(?:stddev|mdev) = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/);
        if (statsMatch?.[1] && statsMatch?.[2] && statsMatch?.[3]) {
            result.alive = true;
            result.minMs = Number.parseFloat(statsMatch[1]);
            result.avgMs = Number.parseFloat(statsMatch[2]);
            result.maxMs = Number.parseFloat(statsMatch[3]);
        }
        else {
            const timeMatches = output.match(/time=([\d.]+) ms/g);
            if (timeMatches && timeMatches.length > 0) {
                const times = timeMatches
                    .map((match) => Number.parseFloat(match.replace(/[^\d.]/g, '')))
                    .filter((time) => Number.isFinite(time) && time > 0);
                if (times.length > 0) {
                    result.alive = true;
                    result.minMs = Math.min(...times);
                    result.maxMs = Math.max(...times);
                    result.avgMs = times.reduce((sum, t) => sum + t, 0) / times.length;
                }
            }
        }
        const lossMatch = output.match(/(\d+)% packet loss/);
        if (lossMatch?.[1]) {
            result.packetLoss = Number.parseInt(lossMatch[1], 10);
        }
        return result;
    }
    async _getNetworkInfo() {
        const interfaces = os.networkInterfaces();
        const dnsServers = dns.getServers();
        for (const [name, addrs] of Object.entries(interfaces)) {
            if (!addrs)
                continue;
            for (const addr of addrs) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    const lower = name.toLowerCase();
                    const connectionType = lower.includes('wifi') ||
                        lower.includes('wlan') ||
                        lower.startsWith('wl')
                        ? 'wifi'
                        : lower.includes('rmnet') || lower.includes('wwan')
                            ? 'mobile'
                            : lower.includes('eth') || lower.startsWith('en')
                                ? 'ethernet'
                                : 'unknown';
                    return {
                        isConnected: true,
                        connectionType,
                        ipAddress: addr.address,
                        interfaceName: name,
                        dnsServers,
                        gateway: await this._getGateway()
                    };
                }
            }
        }
        return {
            isConnected: false,
            connectionType: 'unknown',
            dnsServers
        };
    }
    async _getGateway() {
        try {
            const platform = os.platform();
            if (platform === 'win32') {
                const { stdout } = await execAsync('ipconfig');
                const gatewayMatch = stdout.match(/Default Gateway[.\s]*:\s*([0-9.]+)/);
                return gatewayMatch ? gatewayMatch[1] : undefined;
            }
            if (platform === 'darwin') {
                const { stdout } = await execAsync('route -n get default');
                const gatewayMatch = stdout.match(/gateway:\\s*([0-9.]+)/);
                return gatewayMatch ? gatewayMatch[1] : undefined;
            }
            const { stdout } = await execAsync('ip route');
            const gatewayMatch = stdout.match(/default via ([0-9.]+)/);
            return gatewayMatch ? gatewayMatch[1] : undefined;
        }
        catch {
            return undefined;
        }
    }
}
