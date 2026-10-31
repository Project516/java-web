import java.io.IOException;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.channels.*;
import java.nio.file.Files;
import java.nio.file.Path;

// Accept queues and unaccepted connections. Host sockets under Node accept ahead of the program, so this runs on loopback only.
public class Backlog {
    static final InetAddress LO = InetAddress.getLoopbackAddress();

    public static void main(String[] args) throws Exception {
        queueFull();
        pendingConnect(true);
        pendingConnect(false);
        unixListenerResets();
    }

    static void fill(ServerSocket server) throws IOException {
        for (int i = 0; i < 2; i++) new Socket(LO, server.getLocalPort());
    }

    // a listen backlog of 1 holds two connections
    static void queueFull() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 1, LO)) {
            fill(server);
            try (Socket c = new Socket()) {
                c.connect(new InetSocketAddress(LO, server.getLocalPort()), 300);
                System.out.println("connected");
            } catch (SocketTimeoutException e) {
                System.out.println(e.getMessage());
            }
        }
    }

    static void pendingConnect(boolean accept) throws Exception {
        ServerSocket server = new ServerSocket(0, 1, LO);
        Socket first = new Socket(LO, server.getLocalPort());
        new Socket(LO, server.getLocalPort());
        Thread t = new Thread(() -> {
            try (Socket c = new Socket(LO, server.getLocalPort())) {
                System.out.println("late connect done");
            } catch (IOException e) {
                System.out.println("late connect " + e);
            }
        });
        t.start();
        Thread.sleep(300);
        System.out.println("pending " + t.isAlive());
        if (accept) {
            server.accept();
        } else {
            server.close();
        }
        t.join();
        if (!accept) {
            try {
                first.getInputStream().read();
            } catch (IOException e) {
                System.out.println(e);
            }
        }
        server.close();
    }

    static void unixListenerResets() throws Exception {
        Path path = Path.of("backlog-" + ProcessHandle.current().pid() + ".sock");
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(path));
            try (SocketChannel c = SocketChannel.open(UnixDomainSocketAddress.of(path))) {
                server.close();
                try {
                    System.out.println(c.read(ByteBuffer.allocate(4)));
                } catch (IOException e) {
                    System.out.println(e);
                }
            }
        } finally {
            Files.deleteIfExists(path);
        }
    }
}
