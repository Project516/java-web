import java.lang.management.ManagementFactory;

public class FileLimit {
    public static void main(String[] args) {
        var os = (com.sun.management.UnixOperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        System.out.println(os.getMaxFileDescriptorCount());
    }
}
