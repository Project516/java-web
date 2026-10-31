import com.sun.net.httpserver.HttpServer;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;

// Called from selftest.html in library mode.
public class SelfTest {
  static native String ping(String s);
  static native String viaLib(String s);

  public static String callsBack(String s) {
    return "java got " + viaLib(s);
  }

  public static String join(String sep, String... parts) {
    return String.join(sep, parts);
  }

  public static void fill(byte[] b) {
    for (int i = 0; i < b.length; i++) b[i] = (byte) (i + 1);
  }

  public static void printParts() {
    System.out.print("a");
    System.out.print("b");
    System.out.println();
  }

  public static void download() throws java.io.IOException {
    try (java.io.FileWriter w = new java.io.FileWriter("/files/downloads/report.txt")) {
      w.write("report");
    }
  }

  // implemented by native.js through System.loadLibrary
  public static class Loaded {
    static {
      System.loadLibrary("native");
    }

    public static native int twice(int n);
  }

  public static void fail() throws java.io.IOException {
    throw new java.io.IOException("disk full");
  }

  public static Item item(String label) {
    return new Item(label);
  }

  public static class Item {
    public int n;
    public final String label;

    public Item(String label) {
      this.label = label;
    }

    public int inc() {
      return ++n;
    }

    public native String shout(String s);
  }

  public static String greet(String name) {
    return "hello " + name;
  }

  public static String viaPage(String s) {
    return "page said " + ping(s);
  }

  public static String hostName() throws Exception {
    return InetAddress.getLocalHost().getHostName();
  }

  // A socket echo and an HTTP request, both between threads of this VM.
  public static String loopback() throws Exception {
    InetAddress lo = InetAddress.getLoopbackAddress();
    String echo;
    try (ServerSocket server = new ServerSocket(0, 50, lo)) {
      Thread t = new Thread(() -> {
        try (Socket s = server.accept()) {
          var in = new BufferedReader(new InputStreamReader(s.getInputStream()));
          new PrintWriter(s.getOutputStream(), true).println(in.readLine().toUpperCase());
        } catch (Exception e) {
          e.printStackTrace();
        }
      });
      t.start();
      try (Socket c = new Socket(lo, server.getLocalPort())) {
        new PrintWriter(c.getOutputStream(), true).println("echo");
        echo = new BufferedReader(new InputStreamReader(c.getInputStream())).readLine();
      }
      t.join();
    }
    HttpServer http = HttpServer.create(new InetSocketAddress(lo, 0), 0);
    http.createContext("/hi", x -> {
      byte[] b = "served".getBytes(StandardCharsets.UTF_8);
      x.sendResponseHeaders(200, b.length);
      x.getResponseBody().write(b);
      x.close();
    });
    http.start();
    try {
      var c = (HttpURLConnection) URI.create("http://" + lo.getHostAddress() + ":" + http.getAddress().getPort() + "/hi").toURL().openConnection();
      return echo + " " + c.getResponseCode() + " " + new String(c.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    } finally {
      http.stop(0);
    }
  }

  // A GET through the VM's HTTP proxy, which hands it to the page's fetch.
  public static String fetch(String url) throws Exception {
    var c = (HttpURLConnection) URI.create(url).toURL().openConnection();
    try (var in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
      return c.getResponseCode() + " " + in.readLine();
    }
  }

  // Compiles one source file into dir and reports diagnostics.
  public static String compile(String dir, String name, String source) throws Exception {
    Path out = Path.of(dir);
    Files.createDirectories(out);
    Path src = out.resolve(name + ".java");
    Files.writeString(src, source);
    JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
    StandardJavaFileManager fm = javac.getStandardFileManager(null, Locale.ROOT, null);
    fm.setLocationFromPaths(StandardLocation.CLASS_OUTPUT, List.of(out));
    List<String> diags = new ArrayList<>();
    boolean ok = javac.getTask(null, fm, d -> diags.add(d.getKind() + " " + d.getLineNumber() + ": " + d.getMessage(Locale.ROOT)),
        List.of("-g", "-XDstringConcat=inline"), null, fm.getJavaFileObjects(src)).call();
    return ok + " " + String.join("; ", diags);
  }
}
