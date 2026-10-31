import java.util.*;

// Small CPU benchmarks; prints one line per benchmark with milliseconds.
public class Bench {
    static int sink;

    static long time(String name, Runnable r) {
        long t = System.nanoTime();
        r.run();
        long ms = (System.nanoTime() - t) / 1_000_000;
        System.out.println(name + " " + ms + " ms");
        return ms;
    }

    static void ints() {
        int acc = 0;
        for (int i = 0; i < 3_000_000; i++) acc = acc * 31 + (i ^ (i >>> 3));
        sink = acc;
    }

    static void longs() {
        long acc = 1;
        for (int i = 0; i < 1_000_000; i++) acc = acc * 6364136223846793005L + 1442695040888963407L;
        sink = (int) acc;
    }

    static void doubles() {
        double x = 0, v = 1;
        for (int i = 0; i < 1_000_000; i++) { double a = -x * 0.01; v += a * 0.1; x += v * 0.1; }
        sink = (int) x;
    }

    static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

    static void calls() { sink = fib(25); }

    static void objects() {
        List<Integer> list = new ArrayList<>();
        for (int i = 0; i < 200_000; i++) list.add(i);
        long s = 0;
        for (int v : list) s += v;
        sink = (int) s;
    }

    static void maps() {
        Map<String, Integer> m = new HashMap<>();
        for (int i = 0; i < 50_000; i++) m.merge("k" + (i % 1000), 1, Integer::sum);
        sink = m.size();
    }

    static void strings() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 50_000; i++) sb.append(i).append(',');
        sink = sb.toString().split(",").length;
    }

    static void sort() {
        Random r = new Random(1);
        int[] a = new int[200_000];
        for (int i = 0; i < a.length; i++) a[i] = r.nextInt();
        Arrays.sort(a);
        sink = a[a.length / 2];
    }

    public static void main(String[] args) {
        long total = 0;
        total += time("ints", Bench::ints);
        total += time("longs", Bench::longs);
        total += time("doubles", Bench::doubles);
        total += time("calls", Bench::calls);
        total += time("objects", Bench::objects);
        total += time("maps", Bench::maps);
        total += time("strings", Bench::strings);
        total += time("sort", Bench::sort);
        System.out.println("total " + total + " ms");
    }
}
