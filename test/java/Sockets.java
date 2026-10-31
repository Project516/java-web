import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.CRC32;

public class Sockets {
    static final InetAddress LO = InetAddress.getLoopbackAddress();

    public static void main(String[] args) throws Exception {
        lineEcho();
        bulk();
        timeoutAndClose();
        refused();
        options();
        selectorEcho();
        udp();
        datagramChannel();
        names();
    }

    static void lineEcho() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 50, LO)) {
            Thread t = Thread.ofPlatform().start(() -> {
                try (Socket s = server.accept()) {
                    var in = new BufferedReader(new InputStreamReader(s.getInputStream()));
                    var out = new PrintWriter(s.getOutputStream(), true);
                    String line;
                    while ((line = in.readLine()) != null) out.println(line.toUpperCase());
                } catch (IOException e) {
                    System.out.println("server " + e);
                }
            });
            try (Socket c = new Socket(LO, server.getLocalPort())) {
                var in = new BufferedReader(new InputStreamReader(c.getInputStream()));
                var out = new PrintWriter(c.getOutputStream(), true);
                for (String w : List.of("hello", "java", "web")) {
                    out.println(w);
                    System.out.println("echo " + in.readLine());
                }
                System.out.println("connected " + c.isConnected() + " bound " + c.isBound());
                System.out.println("same port " + (c.getPort() == server.getLocalPort()));
                c.shutdownOutput();
                System.out.println("eof " + in.readLine());
            }
            t.join();
        }
    }

    static void bulk() throws Exception {
        byte[] data = new byte[3_000_000];
        new Random(7).nextBytes(data);
        try (ServerSocket server = new ServerSocket(0, 50, LO)) {
            CRC32 sent = new CRC32();
            sent.update(data);
            var received = new CompletableFuture<Long>();
            Thread.ofPlatform().start(() -> {
                try (Socket s = server.accept()) {
                    CRC32 crc = new CRC32();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = s.getInputStream().read(buf)) > 0) crc.update(buf, 0, n);
                    received.complete(crc.getValue());
                    s.getOutputStream().write(1);
                } catch (IOException e) {
                    received.completeExceptionally(e);
                }
            });
            try (Socket c = new Socket(LO, server.getLocalPort())) {
                c.getOutputStream().write(data);
                c.shutdownOutput();
                System.out.println("ack " + c.getInputStream().read());
            }
            System.out.println("bulk ok " + (received.get() == sent.getValue()));
        }
    }

    static void timeoutAndClose() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 50, LO)) {
            server.setSoTimeout(100);
            try {
                server.accept();
            } catch (SocketTimeoutException e) {
                System.out.println("accept " + e.getMessage());
            }
            server.setSoTimeout(0);
            Thread closer = Thread.ofPlatform().start(() -> {
                try {
                    Thread.sleep(100);
                    server.close();
                } catch (Exception e) {
                    System.out.println(e);
                }
            });
            try {
                server.accept();
            } catch (SocketException e) {
                System.out.println("accept " + e.getMessage());
            }
            closer.join();
        }
        try (ServerSocket server = new ServerSocket(0, 50, LO); Socket c = new Socket(LO, server.getLocalPort())) {
            c.setSoTimeout(100);
            try {
                c.getInputStream().read();
            } catch (SocketTimeoutException e) {
                System.out.println("read " + e.getMessage());
            }
            Socket peer = server.accept();
            Thread closer = Thread.ofPlatform().start(() -> {
                try {
                    Thread.sleep(100);
                    c.close();
                } catch (Exception e) {
                    System.out.println(e);
                }
            });
            c.setSoTimeout(0);
            try {
                c.getInputStream().read();
            } catch (SocketException e) {
                System.out.println("read " + e.getMessage());
            }
            closer.join();
            System.out.println("peer eof " + peer.getInputStream().read());
            peer.close();
        }
    }

    static void refused() throws Exception {
        int port;
        try (ServerSocket s = new ServerSocket(0, 50, LO)) {
            port = s.getLocalPort();
        }
        try (Socket c = new Socket()) {
            c.connect(new InetSocketAddress(LO, port));
        } catch (ConnectException e) {
            System.out.println(e);
        }
        try (Socket c = new Socket()) {
            c.connect(new InetSocketAddress(LO, port), 2000);
        } catch (ConnectException e) {
            System.out.println(e);
        }
        try (ServerSocket a = new ServerSocket(0, 50, LO)) {
            try (ServerSocket b = new ServerSocket(a.getLocalPort(), 50, LO)) {
                System.out.println("bound twice");
            } catch (BindException e) {
                System.out.println(e);
            }
        }
    }

    static void options() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 50, LO); Socket c = new Socket(LO, server.getLocalPort())) {
            c.setTcpNoDelay(true);
            c.setKeepAlive(true);
            c.setSoLinger(true, 5);
            c.setSendBufferSize(65536);
            c.setReceiveBufferSize(65536);
            System.out.println("nodelay " + c.getTcpNoDelay() + " keepalive " + c.getKeepAlive());
            System.out.println("linger " + c.getSoLinger());
            System.out.println("buffers " + (c.getSendBufferSize() >= 65536) + " " + (c.getReceiveBufferSize() >= 65536));
            System.out.println("reuse " + server.getReuseAddress());
            System.out.println("local " + c.getLocalAddress().isLoopbackAddress());
        }
    }

    static void selectorEcho() throws Exception {
        try (Selector sel = Selector.open(); ServerSocketChannel ssc = ServerSocketChannel.open()) {
            ssc.bind(new InetSocketAddress(LO, 0));
            ssc.configureBlocking(false);
            ssc.register(sel, SelectionKey.OP_ACCEPT);
            int port = ((InetSocketAddress) ssc.getLocalAddress()).getPort();
            Thread client = Thread.ofPlatform().start(() -> {
                try (SocketChannel sc = SocketChannel.open(new InetSocketAddress(LO, port))) {
                    for (String m : List.of("one", "two", "three")) {
                        sc.write(ByteBuffer.wrap(m.getBytes(StandardCharsets.UTF_8)));
                        ByteBuffer b = ByteBuffer.allocate(16);
                        while (b.position() < m.length()) if (sc.read(b) < 0) break;
                        System.out.println("client got " + new String(b.array(), 0, b.position(), StandardCharsets.UTF_8));
                    }
                } catch (IOException e) {
                    System.out.println("client " + e);
                }
            });
            int accepted = 0, closed = 0;
            while (closed == 0) {
                sel.select();
                for (var it = sel.selectedKeys().iterator(); it.hasNext(); ) {
                    SelectionKey k = it.next();
                    it.remove();
                    if (k.isAcceptable()) {
                        SocketChannel ch = ssc.accept();
                        ch.configureBlocking(false);
                        ch.register(sel, SelectionKey.OP_READ);
                        accepted++;
                    } else if (k.isReadable()) {
                        SocketChannel ch = (SocketChannel) k.channel();
                        ByteBuffer b = ByteBuffer.allocate(16);
                        int n = ch.read(b);
                        if (n < 0) {
                            ch.close();
                            closed++;
                        } else {
                            b.flip();
                            while (b.hasRemaining()) ch.write(b);
                        }
                    }
                }
            }
            client.join();
            System.out.println("accepted " + accepted + " closed " + closed);
            Thread waker = Thread.ofPlatform().start(() -> {
                try {
                    Thread.sleep(100);
                    sel.wakeup();
                } catch (InterruptedException e) {
                }
            });
            System.out.println("select after wakeup " + sel.select());
            waker.join();
            System.out.println("select timeout " + sel.select(50));
        }
    }

    static void udp() throws Exception {
        try (DatagramSocket server = new DatagramSocket(0, LO); DatagramSocket c = new DatagramSocket(0, LO)) {
            Thread t = Thread.ofPlatform().start(() -> {
                try {
                    byte[] buf = new byte[100];
                    for (int i = 0; i < 2; i++) {
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        server.receive(p);
                        String s = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                        byte[] r = s.toUpperCase().getBytes(StandardCharsets.UTF_8);
                        server.send(new DatagramPacket(r, r.length, p.getSocketAddress()));
                    }
                } catch (IOException e) {
                    System.out.println("server " + e);
                }
            });
            for (String m : List.of("ping", "pong")) {
                byte[] b = m.getBytes(StandardCharsets.UTF_8);
                c.send(new DatagramPacket(b, b.length, LO, server.getLocalPort()));
                DatagramPacket p = new DatagramPacket(new byte[100], 100);
                c.setSoTimeout(5000);
                c.receive(p);
                System.out.println("udp " + new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8)
                    + " from server " + (p.getPort() == server.getLocalPort()));
            }
            t.join();
            c.setSoTimeout(100);
            try {
                c.receive(new DatagramPacket(new byte[10], 10));
            } catch (SocketTimeoutException e) {
                System.out.println("udp " + e.getMessage());
            }
            byte[] small = "truncated".getBytes(StandardCharsets.UTF_8);
            server.send(new DatagramPacket(small, small.length, LO, c.getLocalPort()));
            DatagramPacket p = new DatagramPacket(new byte[4], 4);
            c.receive(p);
            System.out.println("udp " + new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
        }
    }

    static void datagramChannel() throws Exception {
        try (DatagramChannel a = DatagramChannel.open(); DatagramChannel b = DatagramChannel.open()) {
            a.bind(new InetSocketAddress(LO, 0));
            b.bind(new InetSocketAddress(LO, 0));
            b.connect(a.getLocalAddress());
            a.connect(b.getLocalAddress());
            b.write(ByteBuffer.wrap("connected".getBytes(StandardCharsets.UTF_8)));
            ByteBuffer buf = ByteBuffer.allocate(32);
            a.read(buf);
            System.out.println("channel " + new String(buf.array(), 0, buf.position(), StandardCharsets.UTF_8));
            a.configureBlocking(false);
            buf.clear();
            System.out.println("nothing " + a.read(buf));
            a.disconnect();
            System.out.println("connected " + a.isConnected());
        }
    }

    static void names() throws Exception {
        System.out.println(InetAddress.getByName("localhost"));
        System.out.println(InetAddress.getByName("127.0.0.1").isLoopbackAddress());
        System.out.println(InetAddress.getByAddress(new byte[] {10, 1, 2, 3}).getHostAddress());
        System.out.println(InetAddress.getLoopbackAddress());
        var lo = NetworkInterface.getByInetAddress(LO);
        System.out.println(lo.isLoopback() + " " + lo.isUp() + " " + lo.inetAddresses().anyMatch(LO::equals));
        try {
            InetAddress.getByName("no-such-host.invalid");
        } catch (UnknownHostException e) {
            System.out.println("unknown host");
        }
        System.out.println(InetAddress.getLocalHost() != null);
    }
}
