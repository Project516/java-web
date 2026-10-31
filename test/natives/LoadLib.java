public class LoadLib {
    static {
        System.loadLibrary("mylib");
    }

    static native int twice(int n);

    public static void main(String[] args) {
        System.out.println(twice(21));
        System.out.println(System.mapLibraryName("mylib") + " " + System.mapLibraryName("net"));
        try {
            System.loadLibrary("badlib");
        } catch (UnsatisfiedLinkError e) {
            System.out.println(e.getMessage().substring(e.getMessage().indexOf("badlib.js")));
        }
    }
}
