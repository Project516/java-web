package javaweb.tls;

import java.io.IOException;
import java.net.InetAddress;
import java.net.Socket;
import javax.net.ssl.SSLSocketFactory;

final class PassThroughSocketFactory extends SSLSocketFactory {
    @Override
    public String[] getDefaultCipherSuites() { return PassThroughContext.NO_SUITES; }
    @Override
    public String[] getSupportedCipherSuites() { return PassThroughContext.NO_SUITES; }

    // An unconnected socket is not supported, so HttpsClient makes a plain one and layers over it
    @Override
    public Socket createSocket(Socket s, String host, int port, boolean autoClose) {
        return new PassThroughSocket(s, host, port, autoClose);
    }

    @Override
    public Socket createSocket(String host, int port) throws IOException {
        return new PassThroughSocket(new Socket(host, port), host, port, true);
    }

    @Override
    public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException {
        return new PassThroughSocket(new Socket(host, port, local, localPort), host, port, true);
    }

    @Override
    public Socket createSocket(InetAddress host, int port) throws IOException {
        return new PassThroughSocket(new Socket(host, port), host.getHostName(), port, true);
    }

    @Override
    public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) throws IOException {
        return new PassThroughSocket(new Socket(host, port, local, localPort), host.getHostName(), port, true);
    }
}
