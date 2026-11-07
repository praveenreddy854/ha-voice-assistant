import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const python = process.env.GESTURE_SETUP_PYTHON || 'python3';
const environment = path.join(root, '.venv');
execFileSync(python, ['-m', 'venv', environment], { stdio: 'inherit' });
execFileSync(path.join(environment, 'bin', 'python'), [
  '-m', 'pip', 'install', '-r', path.join(root, 'requirements-gesture.txt'),
], { stdio: 'inherit' });
console.log('Gesture dependencies installed in service/.venv. Restart the service to enable detection.');
