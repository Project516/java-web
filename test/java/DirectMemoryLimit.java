// java: -XX:MaxDirectMemorySize=3k -Dsun.nio.MaxDirectMemorySize=1m
import java.nio.ByteBuffer;

public class DirectMemoryLimit {
    static void allocate(int n) {
        try {
            ByteBuffer.allocateDirect(n);
            System.out.println("allocated " + n);
        } catch (OutOfMemoryError e) {
            System.out.println(e.getMessage());
        }
    }

    public static void main(String[] args) {
        System.out.println(System.getProperty("sun.nio.MaxDirectMemorySize"));
        ByteBuffer keep = ByteBuffer.allocateDirect(2048);
        allocate(1024);
        allocate(1);
        allocate(4096);
        keep = null;
    }
}
