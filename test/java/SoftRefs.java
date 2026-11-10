// java: -Xmx16m
import java.lang.ref.ReferenceQueue;
import java.lang.ref.SoftReference;
import java.util.ArrayList;
import java.util.List;

// Soft references survive System.gc() while memory is free, and are cleared
// before an OutOfMemoryError, except those whose referents are strongly reachable.
public class SoftRefs {
  static final int BLOCKS = 32;

  static int live(SoftReference<byte[]>[] refs) {
    int n = 0;
    for (SoftReference<byte[]> r : refs) if (r.get() != null) n++;
    return n;
  }

  @SuppressWarnings("unchecked")
  static SoftReference<byte[]>[] fill(ReferenceQueue<byte[]> queue) {
    SoftReference<byte[]>[] refs = new SoftReference[BLOCKS];
    for (int i = 0; i < BLOCKS; i++) refs[i] = new SoftReference<>(new byte[32768], queue);
    return refs;
  }

  public static void main(String[] args) throws Exception {
    ReferenceQueue<byte[]> queue = new ReferenceQueue<>();
    SoftReference<byte[]>[] refs = fill(queue);
    byte[] kept = new byte[32768];
    SoftReference<byte[]> keptRef = new SoftReference<>(kept, queue);
    System.gc();
    System.out.println("after gc " + live(refs));

    List<int[]> chain = new ArrayList<>();
    try {
      while (true) chain.add(new int[65536]);
    } catch (OutOfMemoryError e) {
      chain = null;
    }
    System.out.println("after memory ran out " + live(refs));
    System.out.println("kept " + (keptRef.get() == kept));
    int enqueued = 0;
    while (queue.remove(2000) != null) enqueued++;
    System.out.println("enqueued " + enqueued);
  }
}
