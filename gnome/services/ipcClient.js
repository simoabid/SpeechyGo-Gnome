import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

let requestCounter = 0;

function nextRequestId() {
    requestCounter += 1;
    return `${Date.now()}-${requestCounter}`;
}

export class CompanionClient {
    constructor(extensionPath) {
        this._extensionPath = extensionPath;
        this._pythonBinary = GLib.find_program_in_path('python3') || 'python3';
        this._scriptPath = GLib.build_filenamev([extensionPath, 'companion', 'main.py']);
    }

    async healthCheck() {
        return this.request('health_check', {});
    }

    async request(action, payload = {}) {
        const request = {
            id: nextRequestId(),
            action,
            payload,
        };

        const argv = [
            this._pythonBinary,
            this._scriptPath,
            '--request',
            JSON.stringify(request),
        ];

        let process;
        try {
            process = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            throw new Error(`Failed to start companion process: ${error.message}`);
        }

        const [ok, stdout, stderr] = await this._communicateUtf8(process, null);

        if (!ok) {
            const detail = (stderr || '').trim();
            throw new Error(detail || 'Companion process returned a non-zero exit code');
        }

        let response;
        try {
            response = JSON.parse((stdout || '').trim());
        } catch (error) {
            throw new Error(`Companion returned invalid JSON: ${error.message}`);
        }

        if (!response || typeof response !== 'object') {
            throw new Error('Companion returned an invalid response payload');
        }

        return response;
    }

    _communicateUtf8(process, stdinBuf) {
        return new Promise((resolve, reject) => {
            process.communicate_utf8_async(stdinBuf, null, (proc, result) => {
                try {
                    resolve(proc.communicate_utf8_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }
}
