import com.sun.management.UnixOperatingSystemMXBean;
import java.io.File;
import java.io.FileInputStream;
import java.io.RandomAccessFile;
import java.lang.management.ManagementFactory;

public class OpenFileDescriptors {
    public static void main(String[] args) throws Exception {
        var os = (UnixOperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        System.out.println("max > 0: " + (os.getMaxFileDescriptorCount() > 0));
        System.out.println("open >= 3: " + (os.getOpenFileDescriptorCount() >= 3));
        File f = File.createTempFile("fds", null);
        try {
            long before = os.getOpenFileDescriptorCount();
            var in = new FileInputStream(f);
            var raf = new RandomAccessFile(f, "rw");
            System.out.println("opened 2: " + (os.getOpenFileDescriptorCount() - before));
            in.close();
            System.out.println("closed 1: " + (os.getOpenFileDescriptorCount() - before));
            raf.close();
            System.out.println("closed 2: " + (os.getOpenFileDescriptorCount() - before));
        } finally {
            f.delete();
        }
    }
}
