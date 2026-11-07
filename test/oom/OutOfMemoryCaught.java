public class OutOfMemoryCaught {
    public static void main(String[] args) {
        try {
            long[] big = new long[Integer.MAX_VALUE - 8];
            System.out.println(big.length);
        } catch (OutOfMemoryError e) {
            System.out.println("caught " + e.getMessage());
        }
    }
}
