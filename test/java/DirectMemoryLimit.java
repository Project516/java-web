// java: -XX:MaxDirectMemorySize=3k -Dsun.nio.MaxDirectMemorySize=1m
import java.lang.ref.Reference;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

public class DirectMemoryLimit {
    // holds every buffer, so the limit counts the ones still reachable
    static final List<ByteBuffer> buffers = new ArrayList<>();

    static void allocate(int n) {
        try {
            buffers.add(ByteBuffer.allocateDirect(n));
            System.out.println("allocated " + n);
        } catch (OutOfMemoryError e) {
            System.out.println(e.getMessage());
        }
    }

    public static void main(String[] args) {
        System.out.println(System.getProperty("sun.nio.MaxDirectMemorySize"));
        allocate(2048);
        allocate(1024);
        allocate(1);
        allocate(4096);
        Reference.reachabilityFence(buffers);
    }
}
