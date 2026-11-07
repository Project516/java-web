// java: -XX:+UseG1GC
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryManagerMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class MemoryManagers {
  public static void main(String[] args) {
    // the order of the platform's managers depends on the JDK's hashing, so the lines are sorted
    List<String> lines = new ArrayList<>();
    for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
      lines.add("pool " + p.getName() + " " + p.getType() + " " + p.isUsageThresholdSupported()
          + " " + p.isCollectionUsageThresholdSupported() + " " + Arrays.toString(p.getMemoryManagerNames()));
    }
    for (MemoryManagerMXBean m : ManagementFactory.getMemoryManagerMXBeans()) {
      lines.add("manager " + m.getName() + " " + Arrays.toString(m.getMemoryPoolNames()) + " " + (m instanceof GarbageCollectorMXBean));
    }
    Collections.sort(lines);
    lines.forEach(System.out::println);
  }
}
