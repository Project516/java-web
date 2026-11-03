// java: --add-opens java.base/sun.nio.fs=ALL-UNNAMED --add-opens java.base/java.io=ALL-UNNAMED
import java.io.FileDescriptor;
import java.io.RandomAccessFile;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

public class FstatAfterUnlink {
  private static Object stat(int fd) throws Exception {
    Class<?> attrs = Class.forName("sun.nio.fs.UnixFileAttributes");
    Method get = attrs.getDeclaredMethod("get", int.class);
    get.setAccessible(true);
    return get.invoke(null, fd);
  }

  private static Object value(Object attrs, String name) throws Exception {
    Method method = attrs.getClass().getDeclaredMethod(name);
    method.setAccessible(true);
    return method.invoke(attrs);
  }

  public static void main(String[] args) throws Exception {
    Path path = Files.createTempFile("fstat-unlink", ".tmp");
    try (RandomAccessFile file = new RandomAccessFile(path.toFile(), "rw")) {
      file.write(new byte[10]);
      Field descriptor = FileDescriptor.class.getDeclaredField("fd");
      descriptor.setAccessible(true);
      int fd = descriptor.getInt(file.getFD());
      long originalInode = (long) value(stat(fd), "ino");
      Path renamed = path.resolveSibling(path.getFileName() + ".renamed");
      Files.move(path, renamed);
      path = renamed;
      if ((long) value(stat(fd), "ino") != originalInode) throw new AssertionError("renamed inode changed");
      Files.delete(path);
      file.write(new byte[5]);
      Method chmod = Class.forName("sun.nio.fs.UnixNativeDispatcher").getDeclaredMethod("fchmod", int.class, int.class);
      chmod.setAccessible(true);
      chmod.invoke(null, fd, 0640);
      Files.writeString(path, "fresh");
      Object attrs = stat(fd);
      boolean regular = (boolean) value(attrs, "isRegularFile");
      long size = (long) value(attrs, "size");
      long ino = (long) value(attrs, "ino");
      if (ino != originalInode) throw new AssertionError("detached inode changed");
      int links = (int) value(attrs, "nlink");
      if (((int) value(attrs, "mode") & 0777) != 0640) throw new AssertionError("detached permissions");
      try (RandomAccessFile fresh = new RandomAccessFile(path.toFile(), "r")) {
        if (ino == (long) value(stat(descriptor.getInt(fresh.getFD())), "ino"))
          throw new AssertionError("detached descriptor has replacement inode");
      }
      if (!regular || size != 15 || links != 0)
        throw new AssertionError("detached attrs: regular=" + regular + " size=" + size + " links=" + links);
      System.out.println("detached " + regular + " " + size);
    }
    try {
      stat(-1);
    } catch (InvocationTargetException e) {
      Method errno = e.getCause().getClass().getDeclaredMethod("errno");
      errno.setAccessible(true);
      int code = (int) errno.invoke(e.getCause());
      if (code != 9) throw new AssertionError("invalid fd errno=" + code);
      System.out.println("invalid " + code);
    }
    Files.delete(path);
  }
}
