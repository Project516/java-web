import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public class UnixSockets {
    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("uds");
        Path path = dir.resolve("echo.sock");
        var address = UnixDomainSocketAddress.of(path);
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(address);
            System.out.println("bound " + server.getLocalAddress().equals(address) + " " + Files.exists(path));
            Thread t = Thread.ofPlatform().start(() -> {
                try (SocketChannel s = server.accept()) {
                    ByteBuffer b = ByteBuffer.allocate(32);
                    while (s.read(b) > 0 && b.position() < 5) {
                    }
                    b.flip();
                    s.write(b);
                } catch (IOException e) {
                    System.out.println("server " + e);
                }
            });
            try (SocketChannel c = SocketChannel.open(address)) {
                c.write(ByteBuffer.wrap("hello".getBytes(StandardCharsets.UTF_8)));
                ByteBuffer b = ByteBuffer.allocate(32);
                while (b.position() < 5) if (c.read(b) < 0) break;
                System.out.println("echo " + new String(b.array(), 0, b.position(), StandardCharsets.UTF_8));
                System.out.println("remote " + c.getRemoteAddress().equals(address));
            }
            t.join();
        }
        try (SocketChannel c = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            c.connect(address);
        } catch (IOException e) {
            System.out.println(e.getClass().getSimpleName());
        }
        try (ServerSocketChannel again = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            again.bind(address);
        } catch (IOException e) {
            System.out.println(e.getClass().getSimpleName());
        }
        Files.delete(path);
        Files.delete(dir);

        Pipe pipe = Pipe.open();
        pipe.sink().write(ByteBuffer.wrap("through a pipe".getBytes(StandardCharsets.UTF_8)));
        ByteBuffer b = ByteBuffer.allocate(32);
        pipe.source().read(b);
        System.out.println(new String(b.array(), 0, b.position(), StandardCharsets.UTF_8));
        pipe.source().configureBlocking(false);
        b.clear();
        System.out.println("empty " + pipe.source().read(b));
        try (Selector sel = Selector.open()) {
            pipe.source().register(sel, SelectionKey.OP_READ);
            System.out.println("ready " + sel.selectNow());
            pipe.sink().write(ByteBuffer.wrap(new byte[] {1}));
            System.out.println("ready " + sel.select(2000));
            sel.selectedKeys().clear();
            pipe.sink().close();
            b.clear();
            pipe.source().read(b);
            b.clear();
            System.out.println("eof " + pipe.source().read(b));
        }
        pipe.source().close();
        paths();
    }

    // A path names a file: a deleted one can be bound again, and equal paths reach the same socket.
    static void paths() throws Exception {
        Path dir = Files.createTempDirectory("uds");
        Files.createDirectory(dir.resolve("sub"));
        Path path = dir.resolve("a.sock");
        try (ServerSocketChannel old = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
             ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            old.bind(UnixDomainSocketAddress.of(path));
            Files.delete(path);
            server.bind(UnixDomainSocketAddress.of(path));
            System.out.println("bound again after delete");
            for (Path alt : new Path[] {dir.resolve("./a.sock"), dir.resolve("sub/../a.sock"), path}) {
                try (SocketChannel c = SocketChannel.open(UnixDomainSocketAddress.of(alt))) {
                    server.accept().close();
                    System.out.println("connected");
                }
            }
        }
        Files.deleteIfExists(path);
        Files.delete(dir.resolve("sub"));
        Files.delete(dir);

        Path relative = Path.of("uds-" + ProcessHandle.current().pid() + ".sock");
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(relative));
            System.out.println("relative " + server.getLocalAddress().equals(UnixDomainSocketAddress.of(relative)));
            try (SocketChannel c = SocketChannel.open(UnixDomainSocketAddress.of(relative.toAbsolutePath()))) {
                server.accept().close();
                System.out.println("connected by absolute path");
            }
        }
        Files.deleteIfExists(relative);
    }
}
