import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.ObjectStreamClass;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

// Java serialization round trips, and the stream bytes match HotSpot's.
public class Serial {
  enum Color { RED, GREEN }

  record Point(int x, int y) implements Serializable {}

  static class Node implements Serializable {
    static int created;
    String name;
    transient int cache = 42;
    Node next;
    int[] data;
    Color color;

    Node(String name) {
      this.name = name;
      created++;
    }

    private void writeObject(ObjectOutputStream out) throws IOException {
      out.defaultWriteObject();
      out.writeUTF("extra:" + name);
    }

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
      in.defaultReadObject();
      name = name + "/" + in.readUTF();
    }
  }

  public static void main(String[] args) throws Exception {
    Node a = new Node("a");
    Node b = new Node("b");
    a.next = b;
    b.next = a;
    a.data = new int[] {1, 2, 3};
    a.color = Color.GREEN;
    Map<String, Object> map = new TreeMap<>(Map.of("k", 1, "p", new Point(3, 4)));
    List<Object> list = new ArrayList<>(List.of("s", 2.5, 7L, map, a));
    HashMap<String, Integer> hm = new HashMap<>();
    hm.put("one", 1);

    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (ObjectOutputStream out = new ObjectOutputStream(bytes)) {
      out.writeObject(list);
      out.writeObject(hm);
      out.writeObject(Color.RED);
    }
    byte[] raw = bytes.toByteArray();
    System.out.println("bytes " + raw.length + " hash " + java.util.Arrays.hashCode(raw));

    try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(raw))) {
      @SuppressWarnings("unchecked")
      List<Object> back = (List<Object>) in.readObject();
      Node n = (Node) back.get(4);
      System.out.println(back.subList(0, 4));
      System.out.println(n.name + " " + n.next.name + " cycle " + (n.next.next == n) + " cache " + n.cache
          + " data " + java.util.Arrays.toString(n.data) + " " + n.color + " same enum " + (n.color == Color.GREEN));
      System.out.println(in.readObject() + " " + (in.readObject() == Color.RED));
    }
    System.out.println("suid " + ObjectStreamClass.lookup(Node.class).getSerialVersionUID());
    System.out.println("constructors run " + Node.created);
  }
}
