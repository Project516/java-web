import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.security.Security;
import javax.net.ssl.*;

public class HttpProxy {
    static String text(InputStream in) throws IOException {
        try (in) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    static HttpURLConnection open(String url) throws IOException {
        return (HttpURLConnection) URI.create(url).toURL().openConnection();
    }

    static String exchange(String request) throws IOException {
        try (Socket socket = new Socket("127.0.0.2", 3128)) {
            socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            socket.shutdownOutput();
            return new String(socket.getInputStream().readAllBytes(), StandardCharsets.US_ASCII).replace("\r\n", "|");
        }
    }

    // CONNECT answers, and what a request inside a tunnel is sent to
    static void raw() throws IOException {
        System.out.println(exchange("CONNECT nowhere HTTP/1.1\r\n\r\n"));
        System.out.println(exchange("CONNECT a.test:99999 HTTP/1.1\r\n\r\n"));
        System.out.println(exchange("CONNECT web.test:443 HTTP/1.1\r\n\r\nGET /hello?raw HTTP/1.1\r\nHost: other.test\r\nConnection: close\r\n\r\n"));
        System.out.println(exchange("CONNECT web.test:443 HTTP/1.1\r\n\r\nGET http://other.test/ HTTP/1.1\r\nHost: other.test\r\n\r\n"));
    }

    public static void main(String[] args) throws Exception {
        System.out.println(System.getProperty("http.proxyHost") + ":" + System.getProperty("http.proxyPort") + " " + System.getProperty("http.nonProxyHosts") + " " + Security.getProperty("security.provider.1"));
        if (args.length > 0) {
            if (args[0].equals("raw")) raw();
            else System.out.println(System.getProperty("https.proxyHost") + ":" + System.getProperty("https.proxyPort"));
            return;
        }
        System.out.println(text(URI.create("http://web.test/hello?a=1").toURL().openStream()));

        HttpURLConnection c = open("http://web.test/echo");
        c.setDoOutput(true);
        c.setRequestProperty("X-Custom", "yes");
        c.getOutputStream().write("posted body".getBytes(StandardCharsets.UTF_8));
        System.out.println(c.getResponseCode() + " " + c.getHeaderField("X-Method") + " " + c.getHeaderField("X-Custom") + " " + text(c.getInputStream()));

        c = open("http://web.test/echo");
        c.setDoOutput(true);
        c.setChunkedStreamingMode(4);
        c.getOutputStream().write("chunked body".getBytes(StandardCharsets.UTF_8));
        System.out.println(c.getResponseCode() + " " + text(c.getInputStream()));

        c = open("http://web.test/missing");
        System.out.println(c.getResponseCode() + " " + text(c.getErrorStream()));

        c = open("http://web.test/gzip");
        System.out.println(c.getResponseCode() + " " + c.getHeaderField("Content-Encoding") + " " + text(c.getInputStream()));

        c = open("http://web.test/empty");
        System.out.println(c.getResponseCode() + " " + c.getContentLength());

        c = open("http://web.test/hello?head");
        c.setRequestMethod("HEAD");
        System.out.println(c.getResponseCode() + " " + c.getContentLength());

        c = open("http://web.test/gzip");
        c.setRequestMethod("HEAD");
        System.out.println(c.getResponseCode() + " " + c.getContentLength());

        HttpClient client = HttpClient.newHttpClient();
        HttpResponse<String> r = client.send(HttpRequest.newBuilder(URI.create("http://web.test/hello?client")).build(),
            HttpResponse.BodyHandlers.ofString());
        System.out.println(r.statusCode() + " " + r.body() + " " + r.headers().firstValue("x-method").orElse("?"));
        r = client.send(HttpRequest.newBuilder(URI.create("http://web.test/echo"))
            .POST(HttpRequest.BodyPublishers.ofString("from client")).build(), HttpResponse.BodyHandlers.ofString());
        System.out.println(r.statusCode() + " " + r.body());

        try {
            text(URI.create("http://down.test/").toURL().openStream());
        } catch (IOException e) {
            System.out.println("IOException " + e.getMessage());
        }
        c = open("http://down.test/");
        System.out.println(c.getResponseCode() + " " + text(c.getErrorStream()));
        System.out.println(client.send(HttpRequest.newBuilder(URI.create("http://down.test/")).build(), HttpResponse.BodyHandlers.ofString()).statusCode());

        System.out.println(SSLContext.getDefault().getProvider().getName() + " " + SSLContext.getInstance("TLS").getProvider().getName());
        System.out.println(text(URI.create("https://web.test/hello?a=1").toURL().openStream()));

        HttpsURLConnection s = (HttpsURLConnection) open("https://web.test:8443/echo");
        s.setDoOutput(true);
        s.setRequestProperty("X-Custom", "secure");
        s.getOutputStream().write("posted over https".getBytes(StandardCharsets.UTF_8));
        System.out.println(s.getResponseCode() + " " + s.getHeaderField("X-Custom"));
        System.out.println(s.getCipherSuite());
        try {
            s.getServerCertificates();
        } catch (SSLPeerUnverifiedException e) {
            System.out.println("SSLPeerUnverifiedException " + e.getMessage());
        }
        System.out.println(text(s.getInputStream()));

        s = (HttpsURLConnection) open("https://web.test/missing");
        System.out.println(s.getResponseCode() + " " + text(s.getErrorStream()));

        s = (HttpsURLConnection) open("https://strict.test/");
        s.setHostnameVerifier((host, session) -> false);
        try {
            s.getResponseCode();
        } catch (IOException e) {
            System.out.println("IOException " + e.getMessage());
        }

        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, null, null);
        s = (HttpsURLConnection) open("https://lenient.test/hello?lenient");
        s.setSSLSocketFactory(context.getSocketFactory());
        s.setHostnameVerifier((host, session) -> true);
        System.out.println(text(s.getInputStream()));
        try {
            context.createSSLEngine().beginHandshake();
        } catch (SSLException e) {
            System.out.println("SSLException " + e.getMessage());
        }

        s = (HttpsURLConnection) open("https://down.test/");
        System.out.println(s.getResponseCode() + " " + text(s.getErrorStream()));

        HttpResponse<String> sr = client.send(HttpRequest.newBuilder(URI.create("https://web.test/hello?client")).build(),
            HttpResponse.BodyHandlers.ofString());
        System.out.println(sr.statusCode() + " " + sr.body() + " " + sr.version() + " " + sr.sslSession().get().getCipherSuite());
        sr = client.send(HttpRequest.newBuilder(URI.create("https://web.test:8443/echo"))
            .header("X-Custom", "secure").POST(HttpRequest.BodyPublishers.ofString("from https client")).build(), HttpResponse.BodyHandlers.ofString());
        System.out.println(sr.statusCode() + " " + sr.headers().firstValue("x-custom").orElse("?") + " " + sr.body());
        sr = client.send(HttpRequest.newBuilder(URI.create("https://down.test/")).build(), HttpResponse.BodyHandlers.ofString());
        System.out.println(sr.statusCode());

        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/local", x -> {
            byte[] b = "local server".getBytes(StandardCharsets.UTF_8);
            x.sendResponseHeaders(200, b.length);
            x.getResponseBody().write(b);
            x.close();
        });
        server.start();
        System.out.println(text(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/local").toURL().openStream()));
        server.stop(0);
        System.out.println("done");
    }
}
