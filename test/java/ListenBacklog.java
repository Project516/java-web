import java.io.IOException;
import java.net.*;
import java.nio.channels.*;
import java.util.*;
import java.util.concurrent.*;

public class ListenBacklog {
    static final InetAddress LO = InetAddress.getLoopbackAddress();

    public static void main(String[] args) throws Exception {
        fullQueueTimesOut();
        nonBlockingBurst();
        acceptMakesRoom();
        listenerCloseRefuses();
    }

    static String connect(int port, int timeoutMs, List<Socket> keep) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(LO, port), timeoutMs);
            keep.add(s);
            return "ok";
        } catch (SocketTimeoutException e) {
            close(s);
            return "timeout";
        } catch (IOException e) {
            close(s);
            return e.getClass().getSimpleName();
        }
    }

    static void close(Socket s) {
        try { s.close(); } catch (IOException e) { }
    }

    // a listener that never accepts holds backlog + 1 connections, the rest time out
    static void fullQueueTimesOut() throws Exception {
        List<Socket> clients = new ArrayList<>();
        try (ServerSocket ss = new ServerSocket(0, 2, LO)) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(connect(ss.getLocalPort(), 300, clients)).append(' ');
            System.out.println("backlog 2: " + sb.toString().trim());
        }
        clients.forEach(ListenBacklog::close);
    }

    // non-blocking connects made at once: backlog + 1 finish, the rest stay pending
    static void nonBlockingBurst() throws Exception {
        try (ServerSocket ss = new ServerSocket(0, 10, LO); Selector sel = Selector.open()) {
            List<SocketChannel> channels = new ArrayList<>();
            for (int i = 0; i < 40; i++) {
                SocketChannel sc = SocketChannel.open();
                sc.configureBlocking(false);
                if (!sc.connect(new InetSocketAddress(LO, ss.getLocalPort()))) sc.register(sel, SelectionKey.OP_CONNECT);
                channels.add(sc);
            }
            int finished = 0;
            long end = System.currentTimeMillis() + 1500;
            while (System.currentTimeMillis() < end) {
                sel.select(100);
                for (SelectionKey k : sel.selectedKeys()) {
                    if (((SocketChannel) k.channel()).finishConnect()) {
                        finished++;
                        k.cancel();
                    }
                }
                sel.selectedKeys().clear();
            }
            System.out.println("burst finished " + finished);
            for (SocketChannel sc : channels) sc.close();
        }
    }

    // a blocked connect finishes once accept removes a connection from the queue
    static void acceptMakesRoom() throws Exception {
        List<Socket> clients = new ArrayList<>();
        try (ServerSocket ss = new ServerSocket(0, 1, LO)) {
            int port = ss.getLocalPort();
            int ok = 0;
            for (int i = 0; i < 2; i++) if (connect(port, 1000, clients).equals("ok")) ok++;
            System.out.println("queued " + ok);
            System.out.println("full " + connect(port, 300, clients));
            ExecutorService pool = Executors.newSingleThreadExecutor();
            Future<String> waiting = pool.submit(() -> connect(port, 10000, clients));
            Thread.sleep(300);
            System.out.println("still waiting " + !waiting.isDone());
            try (Socket a = ss.accept()) {
                System.out.println("accepted " + a.getInetAddress().isLoopbackAddress());
            }
            System.out.println("waiting connect " + waiting.get(10, TimeUnit.SECONDS));
            try (Socket a = ss.accept()) {
                System.out.println("accepted again " + a.getInetAddress().isLoopbackAddress());
            }
            pool.shutdown();
        }
        clients.forEach(ListenBacklog::close);
    }

    // a listener that closes while a connect waits refuses it
    static void listenerCloseRefuses() throws Exception {
        List<Socket> clients = new ArrayList<>();
        ServerSocket ss = new ServerSocket(0, 1, LO);
        int port = ss.getLocalPort();
        for (int i = 0; i < 2; i++) connect(port, 1000, clients);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        Future<String> waiting = pool.submit(() -> connect(port, 10000, clients));
        Thread.sleep(300);
        ss.close();
        System.out.println("after close " + waiting.get(10, TimeUnit.SECONDS));
        pool.shutdown();
        clients.forEach(ListenBacklog::close);
    }
}
