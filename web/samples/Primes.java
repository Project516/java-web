import java.util.stream.IntStream;

public class Primes {
    public static void main(String[] args) {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 20000;
        long start = System.nanoTime();
        long count = IntStream.rangeClosed(2, n).filter(Primes::isPrime).count();
        long ms = (System.nanoTime() - start) / 1_000_000;
        System.out.println(count + " primes up to " + n + " in " + ms + " ms");
    }

    static boolean isPrime(int x) {
        for (int d = 2; (long) d * d <= x; d++) if (x % d == 0) return false;
        return true;
    }
}
