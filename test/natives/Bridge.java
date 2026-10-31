public class Bridge {
    static native String send(String json);
    static native int add(int a, int b);
    static native long twice(long v);
    static native boolean not(boolean b);
    static native double half(double d);
    static native int sum(int[] values);
    static native String fail();
    static native void post(String json);
    static native String receive();
    native String describe(String what);
    static native String callback(StringBuilder sb, int[] data);

    static String hello() {
        return "hello from java";
    }

    public static void main(String[] args) throws Exception {
        System.out.println(send("{\"op\":\"ping\"}"));
        System.out.println(add(2, 40) + " " + twice(21L) + " " + not(false) + " " + half(5.0) + " " + sum(new int[] {1, 2, 3}));
        System.out.println(new Bridge().describe("instance"));
        try {
            fail();
        } catch (RuntimeException e) {
            System.out.println("caught " + e.getMessage());
        }
        Thread t = new Thread(() -> System.out.println("thread " + send("{\"op\":\"thread\"}")));
        t.start();
        t.join();

        // Page messages arrive on their own thread while a 20 ms loop runs.
        java.util.concurrent.BlockingQueue<String> inbox = new java.util.concurrent.LinkedBlockingQueue<>();
        Thread receiver = new Thread(() -> {
            for (;;) inbox.add(receive());
        });
        receiver.setDaemon(true);
        receiver.start();
        for (int i = 0; i < 5; i++) {
            post("{\"tick\":" + i + "}");
            Thread.sleep(20);
        }
        StringBuilder got = new StringBuilder();
        for (int i = 0; i < 5; i++) got.append(inbox.take());
        System.out.println("received " + got);

        StringBuilder sb = new StringBuilder("sb");
        int[] data = {1, 2, 3};
        System.out.println(callback(sb, data) + " " + sb + " " + java.util.Arrays.toString(data));
    }
}
