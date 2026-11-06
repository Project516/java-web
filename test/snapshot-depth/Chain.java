public class Chain {
  static final class Node {
    Node next, prev;
    int value;
  }

  static Node head, tail;

  public static int build(int n) {
    for (int i = 0; i < n; i++) {
      Node x = new Node();
      x.value = i;
      x.prev = tail;
      if (tail == null) head = x; else tail.next = x;
      tail = x;
    }
    return n;
  }

  // walks forward summing values, then backward counting
  public static String check() {
    long sum = 0;
    int forward = 0, backward = 0;
    for (Node x = head; x != null; x = x.next) { sum += x.value; forward++; }
    for (Node x = tail; x != null; x = x.prev) backward++;
    return forward + " " + backward + " " + sum;
  }
}
