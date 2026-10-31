package javaweb.tls;

import java.nio.ByteBuffer;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLEngineResult;
import javax.net.ssl.SSLEngineResult.HandshakeStatus;
import javax.net.ssl.SSLEngineResult.Status;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSession;

/** Copies bytes through unchanged. The handshake is one empty task. */
final class PassThroughEngine extends SSLEngine {
    private final PassThroughSession session;
    private String[] protocols = PassThroughContext.PROTOCOLS;
    private String[] suites = PassThroughContext.NO_SUITES;
    private boolean clientMode, needAuth, wantAuth, creation = true;
    private boolean started, taskGiven, done, inboundDone, outboundDone;

    PassThroughEngine(String host, int port) {
        super(host, port);
        session = new PassThroughSession(host, port);
    }

    private void requireClient() throws SSLException {
        if (!clientMode) throw new SSLException("TLS servers are not supported");
    }

    private SSLEngineResult result(Status status, int consumed, int produced) {
        return new SSLEngineResult(status, getHandshakeStatus(), consumed, produced);
    }

    @Override
    public synchronized SSLEngineResult wrap(ByteBuffer[] srcs, int offset, int length, ByteBuffer dst) throws SSLException {
        requireClient();
        if (outboundDone) return result(Status.CLOSED, 0, 0);
        if (!done) {
            started = true;
            return result(Status.OK, 0, 0);
        }
        int consumed = 0;
        boolean pending = false;
        for (int i = offset; i < offset + length; i++) {
            ByteBuffer src = srcs[i];
            int n = Math.min(src.remaining(), dst.remaining());
            pending |= src.remaining() > n;
            if (n > 0) {
                dst.put(dst.position(), src, src.position(), n);
                dst.position(dst.position() + n);
                src.position(src.position() + n);
                consumed += n;
            }
        }
        if (consumed == 0 && pending) return result(Status.BUFFER_OVERFLOW, 0, 0);
        return result(Status.OK, consumed, consumed);
    }

    @Override
    public synchronized SSLEngineResult unwrap(ByteBuffer src, ByteBuffer[] dsts, int offset, int length) throws SSLException {
        requireClient();
        if (inboundDone) return result(Status.CLOSED, 0, 0);
        if (!done) {
            started = true;
            return result(Status.OK, 0, 0);
        }
        if (!src.hasRemaining()) return result(Status.BUFFER_UNDERFLOW, 0, 0);
        int moved = 0;
        for (int i = offset; i < offset + length && src.hasRemaining(); i++) {
            ByteBuffer dst = dsts[i];
            int n = Math.min(src.remaining(), dst.remaining());
            if (n > 0) {
                dst.put(dst.position(), src, src.position(), n);
                dst.position(dst.position() + n);
                src.position(src.position() + n);
                moved += n;
            }
        }
        if (moved == 0) return result(Status.BUFFER_OVERFLOW, 0, 0);
        return result(Status.OK, moved, moved);
    }

    @Override
    public synchronized Runnable getDelegatedTask() {
        if (!started || done || taskGiven) return null;
        taskGiven = true;
        return () -> {
            synchronized (this) {
                done = true;
                session.establish();
            }
        };
    }

    @Override
    public synchronized HandshakeStatus getHandshakeStatus() {
        return started && !done ? HandshakeStatus.NEED_TASK : HandshakeStatus.NOT_HANDSHAKING;
    }

    @Override
    public synchronized void beginHandshake() throws SSLException {
        requireClient();
        started = true;
    }

    // no close_notify exists, so closing is local
    @Override
    public synchronized void closeInbound() { inboundDone = true; }
    @Override
    public synchronized boolean isInboundDone() { return inboundDone; }
    @Override
    public synchronized void closeOutbound() { outboundDone = true; }
    @Override
    public synchronized boolean isOutboundDone() { return outboundDone; }

    @Override
    public SSLSession getSession() { return session; }

    // "" means no application protocol was negotiated, so HttpClient uses HTTP/1.1
    @Override
    public synchronized String getApplicationProtocol() { return done ? "" : null; }
    @Override
    public synchronized String getHandshakeApplicationProtocol() { return done ? "" : null; }

    @Override
    public String[] getSupportedCipherSuites() { return PassThroughContext.NO_SUITES; }
    @Override
    public String[] getEnabledCipherSuites() { return suites.clone(); }
    @Override
    public void setEnabledCipherSuites(String[] suites) { this.suites = suites.clone(); }
    @Override
    public String[] getSupportedProtocols() { return PassThroughContext.PROTOCOLS.clone(); }
    @Override
    public String[] getEnabledProtocols() { return protocols.clone(); }
    @Override
    public void setEnabledProtocols(String[] protocols) { this.protocols = protocols.clone(); }
    @Override
    public void setUseClientMode(boolean mode) { clientMode = mode; }
    @Override
    public boolean getUseClientMode() { return clientMode; }
    @Override
    public void setNeedClientAuth(boolean need) { needAuth = need; }
    @Override
    public boolean getNeedClientAuth() { return needAuth; }
    @Override
    public void setWantClientAuth(boolean want) { wantAuth = want; }
    @Override
    public boolean getWantClientAuth() { return wantAuth; }
    @Override
    public void setEnableSessionCreation(boolean flag) { creation = flag; }
    @Override
    public boolean getEnableSessionCreation() { return creation; }
}
