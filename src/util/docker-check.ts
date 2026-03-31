import { isDockerRunning } from '../core/docker.js';
import { UserError } from './errors.js';

/**
 * Check that Docker is running and throw a helpful UserError if not.
 * Call this at the start of any command that requires Docker.
 */
export async function requireDocker(): Promise<void> {
  const running = await isDockerRunning();
  if (!running) {
    const platform = process.platform;
    let suggestion = 'Start Docker and try again.';
    if (platform === 'darwin') {
      suggestion = 'Start Docker:\n  open -a Docker\n\nThen retry your command.';
    } else if (platform === 'linux') {
      suggestion = 'Start Docker:\n  sudo systemctl start docker\n\nThen retry your command.';
    }
    throw new UserError('Docker is not running', suggestion);
  }
}
