import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

public class Http {
    static void reply(HttpExchange x, int code, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().add("Content-Type", "text/plain");
        x.getResponseHeaders().add("X-Method", x.getRequestMethod());
        x.sendResponseHeaders(code, b.length == 0 ? -1 : b.length);
        if (b.length > 0) x.getResponseBody().write(b);
        x.close();
    }

    public static void main(String[] args) throws Exception {
        InetAddress lo = InetAddress.getLoopbackAddress();
        HttpServer server = HttpServer.create(new InetSocketAddress(lo, 0), 0);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        server.setExecutor(pool);
        server.createContext("/hello", x -> reply(x, 200, "hello " + x.getRequestURI().getQuery()));
        server.createContext("/echo", x -> reply(x, 200, new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
        server.createContext("/missing", x -> reply(x, 404, "no such thing"));
        server.createContext("/old", x -> {
            x.getResponseHeaders().add("Location", "/hello?moved");
            x.sendResponseHeaders(302, -1);
            x.close();
        });
        server.start();
        String base = "http://" + lo.getHostAddress() + ":" + server.getAddress().getPort();

        HttpURLConnection c = (HttpURLConnection) URI.create(base + "/hello?a=1").toURL().openConnection();
        System.out.println(c.getResponseCode() + " " + c.getHeaderField("X-Method") + " " + c.getContentType());
        System.out.println(new String(c.getInputStream().readAllBytes(), StandardCharsets.UTF_8));

        c = (HttpURLConnection) URI.create(base + "/echo").toURL().openConnection();
        c.setDoOutput(true);
        c.setRequestMethod("POST");
        c.getOutputStream().write("posted body".getBytes(StandardCharsets.UTF_8));
        System.out.println(c.getResponseCode() + " " + new String(c.getInputStream().readAllBytes(), StandardCharsets.UTF_8));

        c = (HttpURLConnection) URI.create(base + "/missing").toURL().openConnection();
        System.out.println(c.getResponseCode() + " " + new String(c.getErrorStream().readAllBytes(), StandardCharsets.UTF_8));
        try {
            c.getInputStream();
        } catch (FileNotFoundException e) {
            System.out.println("FileNotFoundException");
        }

        HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL).build();
        HttpResponse<String> r = client.send(HttpRequest.newBuilder(URI.create(base + "/hello?client")).build(),
            HttpResponse.BodyHandlers.ofString());
        System.out.println(r.statusCode() + " " + r.body() + " " + r.headers().firstValue("x-method").orElse("?"));

        r = client.send(HttpRequest.newBuilder(URI.create(base + "/echo"))
            .POST(HttpRequest.BodyPublishers.ofString("from client")).build(), HttpResponse.BodyHandlers.ofString());
        System.out.println(r.statusCode() + " " + r.body());

        r = client.send(HttpRequest.newBuilder(URI.create(base + "/old")).build(), HttpResponse.BodyHandlers.ofString());
        System.out.println(r.statusCode() + " " + r.body());

        var async = client.sendAsync(HttpRequest.newBuilder(URI.create(base + "/hello?async")).build(),
            HttpResponse.BodyHandlers.ofString()).thenApply(HttpResponse::body);
        System.out.println(async.get(30, TimeUnit.SECONDS));

        server.stop(0);
        pool.shutdown();
        System.out.println("done");
    }
}
