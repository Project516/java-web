package javaweb.tls;

import java.security.SecureRandom;
import java.util.Collections;
import java.util.Enumeration;
import javax.net.ssl.*;

final class PassThroughContext extends SSLContextSpi {
    static final String[] PROTOCOLS = {"TLSv1.3", "TLSv1.2"};
    // Java negotiates no cipher suite; the browser does
    static final String[] NO_SUITES = {};

    private static final SSLSessionContext SESSIONS = new SSLSessionContext() {
        public SSLSession getSession(byte[] id) { return null; }
        public Enumeration<byte[]> getIds() { return Collections.emptyEnumeration(); }
        public void setSessionTimeout(int seconds) {}
        public int getSessionTimeout() { return 0; }
        public void setSessionCacheSize(int size) {}
        public int getSessionCacheSize() { return 0; }
    };

    static SSLSessionContext sessions() {
        return SESSIONS;
    }

    @Override
    protected void engineInit(KeyManager[] km, TrustManager[] tm, SecureRandom sr) {}

    @Override
    protected SSLSocketFactory engineGetSocketFactory() {
        return new PassThroughSocketFactory();
    }

    @Override
    protected SSLServerSocketFactory engineGetServerSocketFactory() {
        throw new UnsupportedOperationException("TLS servers are not supported");
    }

    @Override
    protected SSLEngine engineCreateSSLEngine() {
        return new PassThroughEngine(null, -1);
    }

    @Override
    protected SSLEngine engineCreateSSLEngine(String host, int port) {
        return new PassThroughEngine(host, port);
    }

    @Override
    protected SSLSessionContext engineGetServerSessionContext() {
        return SESSIONS;
    }

    @Override
    protected SSLSessionContext engineGetClientSessionContext() {
        return SESSIONS;
    }

    @Override
    protected SSLParameters engineGetDefaultSSLParameters() {
        return new SSLParameters(NO_SUITES, PROTOCOLS);
    }

    @Override
    protected SSLParameters engineGetSupportedSSLParameters() {
        return new SSLParameters(NO_SUITES, PROTOCOLS);
    }
}
