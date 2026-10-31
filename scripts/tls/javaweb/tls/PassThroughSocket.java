package javaweb.tls;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketAddress;
import java.net.SocketException;
import java.net.SocketOption;
import java.nio.channels.SocketChannel;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import javax.net.ssl.HandshakeCompletedEvent;
import javax.net.ssl.HandshakeCompletedListener;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;

/** An SSLSocket that sends and receives through the socket under it unchanged. */
final class PassThroughSocket extends SSLSocket {
    private final Socket base;
    private final boolean autoClose;
    private final PassThroughSession session;
    private final List<HandshakeCompletedListener> listeners = new ArrayList<>();
    private String[] protocols = PassThroughContext.PROTOCOLS;
    private String[] suites = PassThroughContext.NO_SUITES;
    private boolean clientMode = true, needAuth, wantAuth, creation = true, closed, handshaken;

    PassThroughSocket(Socket base, String host, int port, boolean autoClose) {
        this.base = base;
        this.autoClose = autoClose;
        this.session = new PassThroughSession(host, port);
    }

    @Override
    public synchronized void startHandshake() throws IOException {
        if (!clientMode) throw new SSLException("TLS servers are not supported");
        if (handshaken) return;
        handshaken = true;
        session.establish();
        HandshakeCompletedEvent event = new HandshakeCompletedEvent(this, session);
        for (HandshakeCompletedListener l : listeners) l.handshakeCompleted(event);
    }

    @Override
    public SSLSession getSession() {
        try {
            startHandshake();
        } catch (IOException e) {
            // as JSSE does: a failed handshake gives an invalid session
            PassThroughSession failed = new PassThroughSession(null, -1);
            failed.invalidate();
            return failed;
        }
        return session;
    }

    @Override
    public synchronized void addHandshakeCompletedListener(HandshakeCompletedListener l) { listeners.add(l); }
    @Override
    public synchronized void removeHandshakeCompletedListener(HandshakeCompletedListener l) { listeners.remove(l); }

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

    // Socket itself is a stub here: everything below goes to the socket under it
    @Override
    public void connect(SocketAddress endpoint) throws IOException { base.connect(endpoint); }
    @Override
    public void connect(SocketAddress endpoint, int timeout) throws IOException { base.connect(endpoint, timeout); }
    @Override
    public void bind(SocketAddress bindpoint) throws IOException { base.bind(bindpoint); }
    @Override
    public InetAddress getInetAddress() { return base.getInetAddress(); }
    @Override
    public InetAddress getLocalAddress() { return base.getLocalAddress(); }
    @Override
    public int getPort() { return base.getPort(); }
    @Override
    public int getLocalPort() { return base.getLocalPort(); }
    @Override
    public SocketAddress getRemoteSocketAddress() { return base.getRemoteSocketAddress(); }
    @Override
    public SocketAddress getLocalSocketAddress() { return base.getLocalSocketAddress(); }
    @Override
    public SocketChannel getChannel() { return null; }
    @Override
    public InputStream getInputStream() throws IOException { return base.getInputStream(); }
    @Override
    public OutputStream getOutputStream() throws IOException { return base.getOutputStream(); }
    @Override
    public void setTcpNoDelay(boolean on) throws SocketException { base.setTcpNoDelay(on); }
    @Override
    public boolean getTcpNoDelay() throws SocketException { return base.getTcpNoDelay(); }
    @Override
    public void setSoLinger(boolean on, int linger) throws SocketException { base.setSoLinger(on, linger); }
    @Override
    public int getSoLinger() throws SocketException { return base.getSoLinger(); }
    @Override
    public void sendUrgentData(int data) throws IOException { throw new SocketException("urgent data is not supported"); }
    @Override
    public void setOOBInline(boolean on) throws SocketException { base.setOOBInline(on); }
    @Override
    public boolean getOOBInline() throws SocketException { return base.getOOBInline(); }
    @Override
    public void setSoTimeout(int timeout) throws SocketException { base.setSoTimeout(timeout); }
    @Override
    public int getSoTimeout() throws SocketException { return base.getSoTimeout(); }
    @Override
    public void setSendBufferSize(int size) throws SocketException { base.setSendBufferSize(size); }
    @Override
    public int getSendBufferSize() throws SocketException { return base.getSendBufferSize(); }
    @Override
    public void setReceiveBufferSize(int size) throws SocketException { base.setReceiveBufferSize(size); }
    @Override
    public int getReceiveBufferSize() throws SocketException { return base.getReceiveBufferSize(); }
    @Override
    public void setKeepAlive(boolean on) throws SocketException { base.setKeepAlive(on); }
    @Override
    public boolean getKeepAlive() throws SocketException { return base.getKeepAlive(); }
    @Override
    public void setTrafficClass(int tc) throws SocketException { base.setTrafficClass(tc); }
    @Override
    public int getTrafficClass() throws SocketException { return base.getTrafficClass(); }
    @Override
    public void setReuseAddress(boolean on) throws SocketException { base.setReuseAddress(on); }
    @Override
    public boolean getReuseAddress() throws SocketException { return base.getReuseAddress(); }
    @Override
    public <T> Socket setOption(SocketOption<T> name, T value) throws IOException { base.setOption(name, value); return this; }
    @Override
    public <T> T getOption(SocketOption<T> name) throws IOException { return base.getOption(name); }
    @Override
    public Set<SocketOption<?>> supportedOptions() { return base.supportedOptions(); }
    @Override
    public void setPerformancePreferences(int connectionTime, int latency, int bandwidth) {
        base.setPerformancePreferences(connectionTime, latency, bandwidth);
    }
    @Override
    public void shutdownInput() throws IOException { base.shutdownInput(); }
    @Override
    public void shutdownOutput() throws IOException { base.shutdownOutput(); }
    @Override
    public boolean isConnected() { return base.isConnected(); }
    @Override
    public boolean isBound() { return base.isBound(); }
    @Override
    public boolean isInputShutdown() { return base.isInputShutdown(); }
    @Override
    public boolean isOutputShutdown() { return base.isOutputShutdown(); }
    @Override
    public boolean isClosed() { return closed || base.isClosed(); }

    @Override
    public void close() throws IOException {
        closed = true;
        if (autoClose) base.close();
    }

    @Override
    public String toString() { return "PassThroughSocket[" + base + "]"; }
}
