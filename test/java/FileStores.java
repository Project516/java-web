import java.io.File;
import java.nio.ByteBuffer;
import java.nio.file.*;

// A file store reports its host file system's block size and totals, as
// statvfs gives them; direct I/O sizes its buffers from the block size.
public class FileStores {
  public static void main(String[] args) throws Exception {
    Path tmp = Path.of(System.getProperty("java.io.tmpdir"));
    FileStore store = Files.getFileStore(tmp);
    long block = store.getBlockSize();
    System.out.println("block size " + block);
    System.out.println("total positive " + (store.getTotalSpace() > 0));
    System.out.println("File total matches " + (tmp.toFile().getTotalSpace() == store.getTotalSpace()));
    System.out.println("usable within total " + (store.getUsableSpace() <= store.getTotalSpace()));
    System.out.println("missing file " + new File(tmp.toFile(), "no-such-file").getTotalSpace());
    ByteBuffer buf = ByteBuffer.allocateDirect((int) block * 2).alignedSlice((int) block);
    System.out.println("aligned capacity " + buf.capacity());
  }
}
