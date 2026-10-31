import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

public class SocketEdges {
    static final InetAddress LO = InetAddress.getLoopbackAddress();

    public static void main(String[] args) throws Exception {
        connectWithSelector();
        virtualThreads();
        interruptedAccept();
        resetAndBrokenPipe();
        availableAndShutdown();
        multicastSocket();
        reachable();
        wildcardBindConnects();
        listenerCloseResets();
        datagramQueueFull();
        reusePort();
        datagramErrors();
    }

    static void connectWithSelector() throws Exception {
        try (ServerSocketChannel ssc = ServerSocketChannel.open().bind(new InetSocketAddress(LO, 0));
             Selector sel = Selector.open();
             SocketChannel sc = SocketChannel.open()) {
            sc.configureBlocking(false);
            boolean now = sc.connect(ssc.getLocalAddress());
            System.out.println("pending " + sc.isConnectionPending() + " immediate " + now);
            sc.register(sel, SelectionKey.OP_CONNECT);
            while (!sc.isConnected()) {
                sel.select(1000);
                for (var k : sel.selectedKeys()) if (k.isConnectable()) System.out.println("finish " + sc.finishConnect());
                sel.selectedKeys().clear();
            }
            SocketChannel peer = ssc.accept();
            sc.keyFor(sel).interestOps(SelectionKey.OP_WRITE);
            sel.select(1000);
            System.out.println("writable " + sel.selectedKeys().iterator().next().isWritable());
            peer.close();
            sc.keyFor(sel).interestOps(SelectionKey.OP_READ);
            sel.selectedKeys().clear();
            sel.select(1000);
            System.out.println("readable at eof " + sc.read(ByteBuffer.allocate(4)));
        }
        try (SocketChannel sc = SocketChannel.open()) {
            sc.configureBlocking(false);
            int port;
            try (ServerSocket s = new ServerSocket(0, 1, LO)) {
                port = s.getLocalPort();
            }
            try {
                if (!sc.connect(new InetSocketAddress(LO, port))) {
                    while (!sc.finishConnect()) Thread.sleep(10);
                }
            } catch (ConnectException e) {
                System.out.println(e);
            }
        }
    }

    static void virtualThreads() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 50, LO)) {
            var done = new CompletableFuture<String>();
            Thread.ofVirtual().start(() -> {
                try (Socket s = server.accept()) {
                    s.getOutputStream().write(s.getInputStream().readNBytes(5));
                } catch (IOException e) {
                    done.completeExceptionally(e);
                }
            });
            Thread.ofVirtual().start(() -> {
                try (Socket c = new Socket(LO, server.getLocalPort())) {
                    c.getOutputStream().write("hello".getBytes());
                    done.complete(new String(c.getInputStream().readNBytes(5)));
                } catch (IOException e) {
                    done.completeExceptionally(e);
                }
            });
            // a fresh VM starved of CPU takes tens of seconds over its first socket use
            System.out.println("virtual " + done.get(120, TimeUnit.SECONDS));
        }
    }

    static void interruptedAccept() throws Exception {
        try (ServerSocketChannel ssc = ServerSocketChannel.open().bind(new InetSocketAddress(LO, 0))) {
            Thread t = Thread.currentThread();
            Thread.ofPlatform().start(() -> {
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                }
                t.interrupt();
            });
            try {
                ssc.accept();
            } catch (ClosedByInterruptException e) {
                System.out.println("interrupted " + Thread.interrupted());
            }
        }
    }

    static void resetAndBrokenPipe() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 50, LO)) {
            Socket c = new Socket(LO, server.getLocalPort());
            Socket peer = server.accept();
            peer.setSoLinger(true, 0);
            peer.close();
            Thread.sleep(100);
            try {
                c.getInputStream().read();
                System.out.println("no reset");
            } catch (SocketException e) {
                System.out.println(e.getMessage());
            }
            c.close();
        }
        try (ServerSocket server = new ServerSocket(0, 50, LO)) {
            Socket c = new Socket(LO, server.getLocalPort());
            server.accept().close();
            Thread.sleep(100);
            try {
                byte[] big = new byte[1 << 16];
                for (int i = 0; i < 100; i++) c.getOutputStream().write(big);
                System.out.println("wrote");
            } catch (SocketException e) {
                System.out.println("write " + e.getMessage());
            }
            c.close();
        }
    }

    static void availableAndShutdown() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 50, LO); Socket c = new Socket(LO, server.getLocalPort())) {
            Socket peer = server.accept();
            peer.getOutputStream().write(new byte[100]);
            Thread.sleep(100);
            System.out.println("available " + c.getInputStream().available());
            InputStream in = c.getInputStream();
            c.shutdownInput();
            System.out.println("after shutdownInput " + in.read() + " " + c.isInputShutdown());
            c.shutdownOutput();
            System.out.println("peer sees " + peer.getInputStream().read());
            try {
                c.getOutputStream().write(1);
            } catch (SocketException e) {
                System.out.println(e.getMessage());
            }
            peer.close();
        }
    }

    static void multicastSocket() throws Exception {
        try (MulticastSocket s = new MulticastSocket(0)) {
            System.out.println("ttl " + s.getTimeToLive() + " loopback-disabled " + s.getLoopbackMode());
            s.setTimeToLive(3);
            System.out.println("ttl " + s.getTimeToLive());
        }
    }

    static void reachable() throws Exception {
        System.out.println(LO.isReachable(100));
        System.out.println(Arrays.stream(InetAddress.getAllByName("localhost")).anyMatch(InetAddress::isLoopbackAddress));
        System.out.println(InetAddress.getByName("127.0.0.1").getHostName());
    }

    static void wildcardBindConnects() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 50, LO); Socket c = new Socket()) {
            c.bind(null);
            c.connect(new InetSocketAddress(LO, server.getLocalPort()));
            try (Socket peer = server.accept()) {
                System.out.println("local " + c.getLocalAddress() + " remote " + peer.getInetAddress());
            }
        }
    }

    static void listenerCloseResets() throws Exception {
        ServerSocket server = new ServerSocket(0, 50, LO);
        try (Socket c = new Socket(LO, server.getLocalPort())) {
            server.close();
            try {
                c.getInputStream().read();
                System.out.println("no reset");
            } catch (SocketException e) {
                System.out.println("listener closed: " + e.getMessage());
            }
        }
    }

    // Past its receive buffer a socket drops datagrams, and frees the room as they are read.
    static void datagramQueueFull() throws Exception {
        try (DatagramSocket rx = new DatagramSocket(0, LO); DatagramSocket tx = new DatagramSocket(0, LO)) {
            byte[] big = new byte[60000];
            for (int i = 0; i < 100; i++) tx.send(new DatagramPacket(big, big.length, LO, rx.getLocalPort()));
            rx.setSoTimeout(500);
            DatagramPacket p = new DatagramPacket(new byte[60000], 60000);
            int got = 0;
            try {
                while (true) {
                    rx.receive(p);
                    got++;
                }
            } catch (SocketTimeoutException e) {
            }
            System.out.println("some dropped " + (got > 0 && got < 100));
            tx.send(new DatagramPacket(new byte[10], 10, LO, rx.getLocalPort()));
            rx.receive(p);
            System.out.println("after drain " + p.getLength());
        }
    }

    static void reusePort() throws Exception {
        for (boolean both : new boolean[] {true, false}) {
            try (ServerSocketChannel a = ServerSocketChannel.open(); ServerSocketChannel b = ServerSocketChannel.open()) {
                a.setOption(StandardSocketOptions.SO_REUSEPORT, true);
                b.setOption(StandardSocketOptions.SO_REUSEPORT, both);
                a.bind(new InetSocketAddress(LO, 0));
                b.bind(a.getLocalAddress());
                System.out.println("tcp reuseport " + both + " bound");
            } catch (BindException e) {
                System.out.println("tcp reuseport " + both + " " + e.getMessage());
            }
            try (DatagramChannel a = DatagramChannel.open(); DatagramChannel b = DatagramChannel.open()) {
                a.setOption(StandardSocketOptions.SO_REUSEPORT, true);
                b.setOption(StandardSocketOptions.SO_REUSEPORT, both);
                a.bind(new InetSocketAddress(LO, 0));
                b.bind(a.getLocalAddress());
                System.out.println("udp reuseport " + both + " bound");
            } catch (BindException e) {
                System.out.println("udp reuseport " + both + " " + e.getMessage());
            }
        }
    }

    static void datagramErrors() throws Exception {
        int closedPort;
        try (DatagramSocket tmp = new DatagramSocket(0, LO)) {
            closedPort = tmp.getLocalPort();
        }
        DatagramPacket p = new DatagramPacket(new byte[10], 10);
        try (DatagramSocket ds = new DatagramSocket(0, LO)) {
            ds.setSoTimeout(1000);
            ds.send(new DatagramPacket(new byte[1], 1, LO, closedPort));
            try {
                ds.receive(p);
            } catch (SocketTimeoutException e) {
                System.out.println("unconnected " + e.getMessage());
            }
            ds.connect(LO, closedPort);
            ds.send(new DatagramPacket(new byte[1], 1));
            try {
                ds.receive(p);
            } catch (PortUnreachableException e) {
                System.out.println("connected " + e.getClass().getName());
            }
            try {
                ds.send(new DatagramPacket(new byte[65508], 65508));
            } catch (IOException e) {
                System.out.println(e.getClass().getName() + ": " + e.getMessage());
            }
        }
        try (DatagramSocket ds = new DatagramSocket(0, LO)) {
            ds.send(new DatagramPacket(new byte[65507], 65507, LO, closedPort));
            try {
                ds.send(new DatagramPacket(new byte[65508], 65508, LO, closedPort));
            } catch (IOException e) {
                System.out.println(e.getClass().getName() + ": " + e.getMessage());
            }
        }
    }
}
