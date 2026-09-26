import { access } from 'node:fs/promises';
import process from 'node:process';
import { logger } from '../../../utils.js';
export class DockerProvider {
    type = 'docker';
    async isAvailable() {
        if (process.env.DOCKER === 'true' || process.env.IS_DOCKER === 'true') {
            return true;
        }
        try {
            await access('/.dockerenv');
            return true;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                logger('debug', 'DockerProvider', `Docker environment check failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            return false;
        }
    }
    async getLatest(_channel) {
        return null;
    }
    async download(_manifest, _destination) {
        throw new Error('Docker installations must be updated through the container image');
    }
}
