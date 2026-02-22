import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RecorderState, prettyState} from './lib/state.js';
import {CompanionClient} from './services/ipcClient.js';

const ACTIVATION_KEYBINDING = 'activation-shortcut';
const LIVE_DICTATION_KEYBINDING = 'live-dictation-shortcut';

const SpeechyGoIndicator = GObject.registerClass(
class SpeechyGoIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Speechy Go Indicator');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new CompanionClient(extension.path);
        this._state = RecorderState.IDLE;
        this._targetWindow = null;
        this._liveProcess = null;
        this._liveStdoutStream = null;
        this._liveStderrStream = null;
        this._liveInterimText = '';
        this._liveEventQueue = Promise.resolve();
        this._isLiveStopping = false;

        this._buildIndicator();
        this._buildMenu();
        this._syncMenuSensitivity();

        void this._performHealthCheck();
    }

    _buildIndicator() {
        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        this._icon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'system-status-icon',
        });

        box.add_child(this._icon);
        this.add_child(box);
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('Status: Idle', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._startItem = new PopupMenu.PopupMenuItem('Start Recording');
        this._startItem.connect('activate', () => {
            void this._startRecording();
        });
        this.menu.addMenuItem(this._startItem);

        this._stopItem = new PopupMenu.PopupMenuItem('Stop Recording');
        this._stopItem.connect('activate', () => {
            void this._stopRecording();
        });
        this.menu.addMenuItem(this._stopItem);

        this._startLiveItem = new PopupMenu.PopupMenuItem('Start Live Dictation');
        this._startLiveItem.connect('activate', () => {
            void this._startLiveDictation();
        });
        this.menu.addMenuItem(this._startLiveItem);

        this._stopLiveItem = new PopupMenu.PopupMenuItem('Stop Live Dictation');
        this._stopLiveItem.connect('activate', () => {
            this._stopLiveDictation(false);
        });
        this.menu.addMenuItem(this._stopLiveItem);

        this._enhanceClipboardItem = new PopupMenu.PopupMenuItem('Enhance Clipboard Text');
        this._enhanceClipboardItem.connect('activate', () => {
            void this._enhanceClipboardText();
        });
        this.menu.addMenuItem(this._enhanceClipboardItem);

        this._historyPlaceholder = new PopupMenu.PopupMenuItem('History view (coming soon)', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._historyPlaceholder);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._healthCheckItem = new PopupMenu.PopupMenuItem('Run Health Check');
        this._healthCheckItem.connect('activate', () => {
            void this._performHealthCheck();
        });
        this.menu.addMenuItem(this._healthCheckItem);

        this._openPrefsItem = new PopupMenu.PopupMenuItem('Open Preferences');
        this._openPrefsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(this._openPrefsItem);
    }

    _setState(state, detail = '') {
        this._state = state;
        const stateText = prettyState(state);
        const suffix = detail ? ` - ${detail}` : '';
        this._statusItem.label.text = `Status: ${stateText}${suffix}`;

        if (state === RecorderState.ERROR) {
            this._icon.icon_name = 'dialog-error-symbolic';
        } else if (state === RecorderState.RECORDING) {
            this._icon.icon_name = 'media-record-symbolic';
        } else {
            this._icon.icon_name = 'audio-input-microphone-symbolic';
        }

        this._syncMenuSensitivity();
    }

    _syncMenuSensitivity() {
        const isRecording = this._state === RecorderState.RECORDING;
        const isBusy = this._state === RecorderState.PROCESSING || this._state === RecorderState.ENHANCING;
        const isLive = this._liveProcess !== null;

        this._startItem.setSensitive(!isRecording && !isBusy && !isLive);
        this._stopItem.setSensitive((isRecording || isBusy) && !isLive);
        this._startLiveItem.setSensitive(!isRecording && !isBusy && !isLive);
        this._stopLiveItem.setSensitive(isLive);
        this._enhanceClipboardItem.setSensitive(!isRecording && !isBusy && !isLive);
        this._healthCheckItem.setSensitive(!isBusy);
    }

    _runtimeConfig() {
        return {
            deepgram_api_key: this._settings.get_string('deepgram-api-key'),
            gemini_api_key: this._settings.get_string('gemini-api-key'),
            enable_gemini: this._settings.get_boolean('enable-gemini'),
            gemini_model: this._settings.get_string('gemini-model'),
            gemini_prompt: this._settings.get_string('gemini-prompt'),
            enhance_prompt: this._settings.get_string('enhance-prompt'),
            recording_backend: this._settings.get_string('recording-backend'),
            history_limit: this._settings.get_uint('history-limit'),
            notification_mode: this._settings.get_string('notification-mode'),
            debug_logging: this._settings.get_boolean('debug-logging'),
            auto_paste_enabled: this._settings.get_boolean('auto-paste-enabled'),
            auto_paste_delay_ms: this._settings.get_uint('auto-paste-delay-ms'),
            live_streaming_model: this._settings.get_string('live-streaming-model'),
            live_streaming_chunk_ms: this._settings.get_uint('live-streaming-chunk-ms'),
            live_streaming_interim_enabled: this._settings.get_boolean('live-streaming-interim-enabled'),
        };
    }

    async _performHealthCheck() {
        this._setState(RecorderState.PROCESSING, 'Checking companion service');

        try {
            const response = await this._client.healthCheck();
            if (!response.ok) {
                throw new Error(response.error?.message || 'Health check failed');
            }

            const backend = response.result?.recording_backend || 'none';
            this._setState(RecorderState.IDLE, `Ready (backend: ${backend})`);
        } catch (error) {
            this._setState(RecorderState.ERROR, error.message);
            Main.notifyError('Speechy Go', `Health check failed: ${error.message}`);
        }
    }

    async _startRecording() {
        if (this._liveProcess) {
            Main.notifyError('Speechy Go', 'Stop live dictation before starting standard recording.');
            return;
        }

        this._capturePasteTargetWindow();
        this._setState(RecorderState.PROCESSING, 'Starting recording');

        try {
            const response = await this._client.request('start_recording', {
                config: this._runtimeConfig(),
            });

            if (!response.ok) {
                throw new Error(response.error?.message || 'Start recording failed');
            }

            this._setState(RecorderState.RECORDING, response.result?.message || 'Recording in progress');
            Main.notify('Speechy Go', 'Recording started');
        } catch (error) {
            this._setState(RecorderState.ERROR, error.message);
            Main.notifyError('Speechy Go', `Failed to start recording: ${error.message}`);
        }
    }

    async _stopRecording() {
        this._setState(RecorderState.PROCESSING, 'Stopping recording');

        try {
            const response = await this._client.request('stop_recording', {
                config: this._runtimeConfig(),
            });

            if (!response.ok) {
                throw new Error(response.error?.message || 'Stop recording failed');
            }

            const finalText = response.result?.final_text || response.result?.raw_text || '';
            if (finalText) {
                this._setClipboardText(finalText);

                const autoPasted = await this._tryAutoPasteIntoTarget();
                if (autoPasted) {
                    Main.notify('Speechy Go', 'Transcription copied and auto-pasted');
                } else {
                    Main.notify('Speechy Go', 'Transcription copied to clipboard');
                }
            } else {
                Main.notify('Speechy Go', 'Recording stopped (no transcription text returned)');
            }

            this._setState(RecorderState.IDLE, 'Ready');
        } catch (error) {
            this._setState(RecorderState.ERROR, error.message);
            Main.notifyError('Speechy Go', `Failed to stop recording: ${error.message}`);
        }
    }

    async _enhanceClipboardText() {
        if (this._liveProcess) {
            Main.notifyError('Speechy Go', 'Stop live dictation before running text enhancement.');
            return;
        }

        this._setState(RecorderState.ENHANCING, 'Enhancing clipboard text');

        try {
            const text = await this._getClipboardText();
            if (!text || !text.trim()) {
                throw new Error('Clipboard is empty');
            }

            const response = await this._client.request('enhance_text', {
                text,
                config: this._runtimeConfig(),
            });

            if (!response.ok) {
                throw new Error(response.error?.message || 'Enhancement failed');
            }

            const enhancedText = response.result?.text || '';
            if (!enhancedText) {
                throw new Error('Enhancement returned empty text');
            }

            this._setClipboardText(enhancedText);
            Main.notify('Speechy Go', 'Enhanced text copied to clipboard');
            this._setState(RecorderState.IDLE, 'Ready');
        } catch (error) {
            this._setState(RecorderState.ERROR, error.message);
            Main.notifyError('Speechy Go', `Failed to enhance text: ${error.message}`);
        }
    }

    _getClipboardText() {
        return new Promise(resolve => {
            St.Clipboard.get_default().get_text(
                St.ClipboardType.CLIPBOARD,
                (_clipboard, text) => resolve(text || '')
            );
        });
    }

    _setClipboardText(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _capturePasteTargetWindow() {
        try {
            this._targetWindow = global.display.get_focus_window();
        } catch (error) {
            this._targetWindow = null;
        }
    }

    _restoreTargetWindowFocus() {
        if (!this._targetWindow) {
            return false;
        }

        try {
            this._targetWindow.activate(global.get_current_time());
            return true;
        } catch (error) {
            return false;
        }
    }

    async _tryAutoPasteIntoTarget() {
        if (!this._settings.get_boolean('auto-paste-enabled')) {
            return false;
        }

        const hadFocusTarget = this._restoreTargetWindowFocus();
        if (!hadFocusTarget) {
            return false;
        }

        const delayMs = Math.max(20, this._settings.get_uint('auto-paste-delay-ms'));
        await this._sleep(delayMs);

        const pasted = this._sendCtrlVPaste();
        this._targetWindow = null;
        return pasted;
    }

    _sleep(timeoutMs) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _sendCtrlVPaste() {
        try {
            const backend = Clutter.get_default_backend();
            const seat = backend?.get_default_seat?.();
            if (!seat) {
                return false;
            }

            const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            if (!keyboard) {
                return false;
            }

            const keyPaste = Clutter.KEY_v ?? Clutter.KEY_V;
            if (!keyPaste) {
                return false;
            }

            const now = global.get_current_time();
            const pressedState = Clutter.KeyState?.PRESSED ?? 1;
            const releasedState = Clutter.KeyState?.RELEASED ?? 0;

            keyboard.notify_keyval(now, Clutter.KEY_Control_L, pressedState);
            keyboard.notify_keyval(now, keyPaste, pressedState);
            keyboard.notify_keyval(now, keyPaste, releasedState);
            keyboard.notify_keyval(now, Clutter.KEY_Control_L, releasedState);

            return true;
        } catch (error) {
            console.error(`Speechy Go: auto-paste failed: ${error}`);
            return false;
        }
    }

    _sendBackspaces(count) {
        if (count <= 0) {
            return;
        }

        try {
            const backend = Clutter.get_default_backend();
            const seat = backend?.get_default_seat?.();
            if (!seat) {
                return;
            }

            const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            if (!keyboard) {
                return;
            }

            const pressedState = Clutter.KeyState?.PRESSED ?? 1;
            const releasedState = Clutter.KeyState?.RELEASED ?? 0;

            for (let i = 0; i < count; i++) {
                const now = global.get_current_time();
                keyboard.notify_keyval(now, Clutter.KEY_BackSpace, pressedState);
                keyboard.notify_keyval(now, Clutter.KEY_BackSpace, releasedState);
            }
        } catch (error) {
            console.error(`Speechy Go: failed to send backspaces: ${error}`);
        }
    }

    _enqueueLiveEvent(task) {
        this._liveEventQueue = this._liveEventQueue
            .then(() => task())
            .catch(error => {
                console.error(`Speechy Go: live dictation event failed: ${error}`);
            });
    }

    _isLiveMode() {
        return this._liveProcess !== null;
    }

    async _startLiveDictation() {
        if (this._isLiveMode()) {
            return;
        }

        if (this._state === RecorderState.RECORDING || this._state === RecorderState.PROCESSING || this._state === RecorderState.ENHANCING) {
            Main.notifyError('Speechy Go', 'Stop the current task before starting live dictation.');
            return;
        }

        const config = this._runtimeConfig();
        if (!config.deepgram_api_key) {
            Main.notifyError('Speechy Go', 'Deepgram API key is required for live dictation.');
            return;
        }

        this._capturePasteTargetWindow();
        this._liveInterimText = '';
        this._isLiveStopping = false;
        this._setState(RecorderState.PROCESSING, 'Starting live dictation...');

        const pythonBinary = GLib.find_program_in_path('python3') || 'python3';
        const scriptPath = GLib.build_filenamev([this._extension.path, 'companion', 'main.py']);
        const argv = [
            pythonBinary,
            scriptPath,
            '--stream',
            '--config-json',
            JSON.stringify(config),
        ];

        try {
            this._liveProcess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            this._liveProcess = null;
            this._setState(RecorderState.ERROR, 'Failed to start live dictation');
            Main.notifyError('Speechy Go', `Failed to start live dictation: ${error.message}`);
            return;
        }

        this._liveStdoutStream = new Gio.DataInputStream({
            base_stream: this._liveProcess.get_stdout_pipe(),
        });
        this._liveStderrStream = new Gio.DataInputStream({
            base_stream: this._liveProcess.get_stderr_pipe(),
        });

        this._setState(RecorderState.RECORDING, 'Live dictation running');
        this._syncMenuSensitivity();
        Main.notify('Speechy Go', 'Live dictation started');

        this._readLiveStdoutLoop();
        this._readLiveStderrLoop();
        this._watchLiveProcessExit();
    }

    _stopLiveDictation(fromExitCallback) {
        if (!this._isLiveMode()) {
            return;
        }

        if (!this._isLiveStopping) {
            this._isLiveStopping = true;
            this._setState(RecorderState.PROCESSING, 'Stopping live dictation...');
        }

        if (!fromExitCallback && this._liveProcess) {
            try {
                this._liveProcess.send_signal(2); // SIGINT
            } catch (error) {
                try {
                    this._liveProcess.force_exit();
                } catch {
                    // Ignore.
                }
            }
        }
    }

    _cleanupLiveState() {
        this._liveProcess = null;
        this._liveStdoutStream = null;
        this._liveStderrStream = null;
        this._liveInterimText = '';
        this._isLiveStopping = false;
        this._setState(RecorderState.IDLE, 'Ready');
        this._syncMenuSensitivity();
    }

    _watchLiveProcessExit() {
        if (!this._liveProcess) {
            return;
        }

        this._liveProcess.wait_check_async(null, (proc, result) => {
            let ok = false;
            try {
                ok = proc.wait_check_finish(result);
            } catch {
                ok = false;
            }

            const stopping = this._isLiveStopping;
            this._cleanupLiveState();

            if (!ok && !stopping) {
                Main.notifyError('Speechy Go', 'Live dictation process stopped unexpectedly.');
            } else if (stopping) {
                Main.notify('Speechy Go', 'Live dictation stopped');
            }
        });
    }

    _readLiveStdoutLoop() {
        if (!this._liveStdoutStream) {
            return;
        }

        this._liveStdoutStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (error) {
                console.error(`Speechy Go: failed reading live stdout: ${error}`);
                return;
            }

            if (line === null) {
                return;
            }

            this._handleLiveEventLine(line);
            this._readLiveStdoutLoop();
        });
    }

    _readLiveStderrLoop() {
        if (!this._liveStderrStream) {
            return;
        }

        this._liveStderrStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (error) {
                console.error(`Speechy Go: failed reading live stderr: ${error}`);
                return;
            }

            if (line === null) {
                return;
            }

            if (line.trim()) {
                console.error(`Speechy Go companion (stream): ${line}`);
            }

            this._readLiveStderrLoop();
        });
    }

    _handleLiveEventLine(line) {
        if (!line || !line.trim()) {
            return;
        }

        let event;
        try {
            event = JSON.parse(line);
        } catch (error) {
            console.error(`Speechy Go: invalid live event JSON: ${line}`);
            return;
        }

        switch (event.type) {
            case 'session_started':
                this._setState(RecorderState.RECORDING, 'Live dictation running');
                break;
            case 'interim':
                this._enqueueLiveEvent(async () => {
                    await this._applyLiveInterim(event.text || '');
                });
                break;
            case 'final':
                this._enqueueLiveEvent(async () => {
                    await this._applyLiveFinal(event.text || '');
                });
                break;
            case 'error':
                this._setState(RecorderState.ERROR, event.message || 'Live dictation failed');
                Main.notifyError(
                    'Speechy Go',
                    [event.message || 'Live dictation failed', event?.details?.hint || '']
                        .filter(Boolean)
                        .join(' ')
                );
                this._stopLiveDictation(false);
                break;
            case 'session_stopped':
                this._stopLiveDictation(false);
                break;
            default:
                // Ignore unknown events.
                break;
        }
    }

    async _applyLiveInterim(text) {
        if (!this._isLiveMode()) {
            return;
        }

        if (!this._settings.get_boolean('live-streaming-interim-enabled')) {
            return;
        }

        if (!this._settings.get_boolean('auto-paste-enabled')) {
            return;
        }

        const normalized = (text || '').trim();
        if (!normalized) {
            return;
        }

        const focused = this._restoreTargetWindowFocus();
        if (!focused) {
            return;
        }

        await this._sleep(Math.max(20, this._settings.get_uint('auto-paste-delay-ms')));

        this._sendBackspaces(this._liveInterimText.length);
        this._setClipboardText(normalized);
        this._sendCtrlVPaste();
        this._liveInterimText = normalized;
    }

    async _applyLiveFinal(text) {
        if (!this._isLiveMode()) {
            return;
        }

        if (!this._settings.get_boolean('auto-paste-enabled')) {
            return;
        }

        const normalized = (text || '').trim();
        if (!normalized) {
            return;
        }

        const focused = this._restoreTargetWindowFocus();
        if (!focused) {
            return;
        }

        await this._sleep(Math.max(20, this._settings.get_uint('auto-paste-delay-ms')));

        this._sendBackspaces(this._liveInterimText.length);
        this._setClipboardText(normalized);
        this._sendCtrlVPaste();
        this._liveInterimText = '';
    }

    async activateFromShortcut() {
        if (this._isLiveMode()) {
            this._stopLiveDictation(false);
            return;
        }

        if (this._state === RecorderState.RECORDING) {
            await this._stopRecording();
            return;
        }

        if (this._state === RecorderState.PROCESSING || this._state === RecorderState.ENHANCING) {
            Main.notify('Speechy Go', 'Still processing. Please wait before triggering again.');
            return;
        }

        await this._startRecording();
    }

    async activateLiveFromShortcut() {
        if (this._isLiveMode()) {
            this._stopLiveDictation(false);
            return;
        }

        await this._startLiveDictation();
    }
});

export default class SpeechyGoExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new SpeechyGoIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._registerKeybindings();
    }

    disable() {
        if (this._indicator) {
            this._indicator._stopLiveDictation(false);
        }
        this._unregisterKeybindings();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _registerKeybindings() {
        this._registerKeybinding(ACTIVATION_KEYBINDING, () => {
            if (this._indicator) {
                void this._indicator.activateFromShortcut();
            }
        });
        this._registerKeybinding(LIVE_DICTATION_KEYBINDING, () => {
            if (this._indicator) {
                void this._indicator.activateLiveFromShortcut();
            }
        });
    }

    _registerKeybinding(name, callback) {
        try {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL,
                callback
            );
        } catch (error) {
            console.error(`Speechy Go: failed to register keybinding '${name}': ${error}`);
        }
    }

    _unregisterKeybindings() {
        this._unregisterKeybinding(ACTIVATION_KEYBINDING);
        this._unregisterKeybinding(LIVE_DICTATION_KEYBINDING);
    }

    _unregisterKeybinding(name) {
        try {
            Main.wm.removeKeybinding(name);
        } catch (error) {
            // Ignore removal errors when keybinding is not yet registered.
        }
    }
}
