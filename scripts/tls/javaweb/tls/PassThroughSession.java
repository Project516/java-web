package javaweb.tls;

import java.security.Principal;
import java.security.cert.Certificate;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSessionContext;

/**
 * What Java can say about a connection whose TLS the browser did. The cipher
 * suite is the null suite, because Java negotiated none, and there are no
 * certificates: the browser checked them and did not pass them on.
 */
final class PassThroughSession implements SSLSession {
    private final String host;
    private final int port;
    private final long created = System.currentTimeMillis();
    private final Map<String, Object> values = new ConcurrentHashMap<>();
    private volatile boolean established;
    private volatile boolean valid = true;

    PassThroughSession(String host, int port) {
        this.host = host;
        this.port = port;
    }

    void establish() {
        established = true;
    }

    public byte[] getId() { return new byte[0]; }
    public SSLSessionContext getSessionContext() { return PassThroughContext.sessions(); }
    public long getCreationTime() { return created; }
    public long getLastAccessedTime() { return created; }
    public void invalidate() { valid = false; }
    public boolean isValid() { return valid; }
    public void putValue(String name, Object value) { values.put(name, value); }
    public Object getValue(String name) { return values.get(name); }
    public void removeValue(String name) { values.remove(name); }
    public String[] getValueNames() { return values.keySet().toArray(new String[0]); }

    public Certificate[] getPeerCertificates() throws SSLPeerUnverifiedException {
        throw new SSLPeerUnverifiedException("the browser verified the peer and does not pass its certificates on");
    }

    public Certificate[] getLocalCertificates() { return null; }

    public Principal getPeerPrincipal() throws SSLPeerUnverifiedException {
        throw new SSLPeerUnverifiedException("the browser verified the peer and does not pass its certificates on");
    }

    public Principal getLocalPrincipal() { return null; }

    // before the handshake this is the JDK's own value for "no session yet"
    public String getCipherSuite() { return established ? "TLS_NULL_WITH_NULL_NULL" : "SSL_NULL_WITH_NULL_NULL"; }
    public String getProtocol() { return established ? "TLS" : "NONE"; }
    public String getPeerHost() { return host; }
    public int getPeerPort() { return port; }
    public int getPacketBufferSize() { return 16384; }
    public int getApplicationBufferSize() { return 16384; }
}
