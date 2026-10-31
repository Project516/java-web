import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.net.http.HttpClient;
import java.util.List;
import java.util.TreeSet;

// java.lang.management as logging libraries use it, and
// java.net.http classes resolving, as some static initializers need. What
// depends on the collector HotSpot picks (names of collectors and heap pools)
// is not printed.
public class Management {
  public static void main(String[] args) {
    List<GarbageCollectorMXBean> gcs = ManagementFactory.getGarbageCollectorMXBeans();
    long[] counts = new long[gcs.size()];
    for (int i = 0; i < gcs.size(); i++) counts[i] = gcs.get(i).getCollectionCount();
    System.gc();
    long more = 0;
    boolean valid = !gcs.isEmpty();
    for (int i = 0; i < gcs.size(); i++) {
      GarbageCollectorMXBean gc = gcs.get(i);
      more += gc.getCollectionCount() - counts[i];
      valid &= gc.isValid() && gc.getCollectionTime() >= 0 && gc.getMemoryPoolNames().length > 0;
    }
    System.out.println("collectors valid " + valid + ", System.gc counted " + (more > 0));
    TreeSet<String> nonHeap = new TreeSet<>();
    boolean heapCollected = true;
    for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
      if (p.getType() == MemoryType.HEAP) heapCollected &= p.getCollectionUsage() != null;
      else nonHeap.add(p.getName() + " collection " + (p.getCollectionUsage() != null) + " usageThreshold " + p.isUsageThresholdSupported());
    }
    System.out.println("non-heap pools " + nonHeap);
    System.out.println("heap pools have collection usage " + heapCollected);
    var heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
    System.out.println("heap used>0 " + (heap.getUsed() > 0) + " committed>=used " + (heap.getCommitted() >= heap.getUsed()));
    var rt = ManagementFactory.getRuntimeMXBean();
    System.out.println("runtime spec " + rt.getSpecVersion() + " management " + rt.getManagementSpecVersion() + " uptime>=0 " + (rt.getUptime() >= 0));
    var threads = ManagementFactory.getThreadMXBean();
    System.out.println("threads live>0 " + (threads.getThreadCount() > 0) + " peak>=live " + (threads.getPeakThreadCount() >= threads.getThreadCount())
        + " started>=live " + (threads.getTotalStartedThreadCount() >= threads.getThreadCount()));
    System.out.println("classes loaded>0 " + (ManagementFactory.getClassLoadingMXBean().getLoadedClassCount() > 0));
    System.out.println("http " + HttpClient.Version.HTTP_2 + " " + HttpClient.class.getModule().getName());
  }
}
