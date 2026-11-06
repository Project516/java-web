// java: -XX:OnOutOfMemoryError=echo
public class OutOfMemoryHook {
    public static void main(String[] args) {
        System.out.println("start");
        System.out.flush();
        for (int i = 0; i < 2; i++) {
            try {
                Object o = new double[Integer.MAX_VALUE];
            } catch (OutOfMemoryError e) {
                System.out.println("caught " + e.getMessage());
            }
        }
        try {
            Object o = new byte[Integer.MAX_VALUE - 1][];
        } catch (OutOfMemoryError e) {
            System.out.println("caught " + e.getMessage());
        }
        Object o = new int[Integer.MAX_VALUE];
    }
}
