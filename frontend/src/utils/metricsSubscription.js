// Socket ownership for one local metrics consumer. The hook owns fallback
// polling; a disconnect or stream error re-enables that single scheduler.
export function subscribeToMetrics(socket, { onConnected, onMetrics, onError }) {
    const connected = () => {
        onConnected(true);
        socket.subscribeMetrics();
    };
    const unsubscribers = [
        socket.on('connected', connected),
        socket.on('disconnected', () => onConnected(false)),
        socket.on('metrics', onMetrics),
        socket.on('error', (error) => { onConnected(false); onError(error); }),
    ];
    socket.connect();
    // An already-connected socket does not emit another connected event.
    if (socket.socket?.connected) connected();
    return () => {
        unsubscribers.forEach((unsubscribe) => unsubscribe());
        socket.unsubscribeMetrics();
    };
}
