export const RecorderState = Object.freeze({
    IDLE: 'IDLE',
    RECORDING: 'RECORDING',
    PROCESSING: 'PROCESSING',
    ENHANCING: 'ENHANCING',
    ERROR: 'ERROR',
});

export function prettyState(state) {
    switch (state) {
        case RecorderState.IDLE:
            return 'Idle';
        case RecorderState.RECORDING:
            return 'Recording';
        case RecorderState.PROCESSING:
            return 'Processing';
        case RecorderState.ENHANCING:
            return 'Enhancing';
        case RecorderState.ERROR:
            return 'Error';
        default:
            return state;
    }
}
