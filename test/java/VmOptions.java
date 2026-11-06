import com.sun.management.HotSpotDiagnosticMXBean;
import java.lang.management.ManagementFactory;

public class VmOptions {
    public static void main(String[] args) {
        var diag = ManagementFactory.getPlatformMXBean(HotSpotDiagnosticMXBean.class);
        for (String name : new String[] {"LockingMode", "HeapDumpOnOutOfMemoryError"}) {
            var o = diag.getVMOption(name);
            System.out.println(o.getName() + "=" + o.getValue() + " " + o.getOrigin() + " writeable=" + o.isWriteable());
        }
        try {
            diag.getVMOption("NoSuchOption");
        } catch (IllegalArgumentException e) {
            System.out.println("unknown: " + e.getMessage());
        }
    }
}
