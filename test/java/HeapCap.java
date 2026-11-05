// java: -Xmx32m
import java.util.ArrayList;
import java.util.List;

public class HeapCap {
    public static void main(String[] args) {
        List<byte[]> keep = new ArrayList<>();
        try {
            while (true) keep.add(new byte[256 * 1024]);
        } catch (OutOfMemoryError e) {
            System.out.println("OutOfMemoryError: " + e.getMessage());
            keep.clear();
            System.gc();
        }
        for (int i = 0; i < 16; i++) keep.add(new byte[256 * 1024]);
        System.out.println("continued");
    }
}
