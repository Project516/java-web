import java.util.*;
import java.util.stream.*;

public class Collections {
    public static void main(String[] args) {
        Map<String, Integer> hm = new HashMap<>();
        for (String w : "the quick brown fox jumps over the lazy dog the end".split(" ")) hm.merge(w, 1, Integer::sum);
        System.out.println(hm);
        TreeMap<String, Integer> tm = new TreeMap<>(hm);
        System.out.println(tm + " " + tm.firstKey() + " " + tm.headMap("fox") + " " + tm.ceilingEntry("p"));
        LinkedHashMap<Integer, String> lru = new LinkedHashMap<>(16, 0.75f, true) {
            protected boolean removeEldestEntry(Map.Entry<Integer, String> e) { return size() > 3; }
        };
        for (int i = 0; i < 5; i++) { lru.put(i, "v" + i); lru.get(i - 1); }
        System.out.println(lru);
        PriorityQueue<int[]> pq = new PriorityQueue<>(Comparator.comparingInt(a -> a[1]));
        pq.add(new int[] {1, 5}); pq.add(new int[] {2, 1}); pq.add(new int[] {3, 3});
        StringBuilder sb = new StringBuilder();
        while (!pq.isEmpty()) sb.append(pq.poll()[0]);
        System.out.println(sb);
        Deque<Integer> dq = new ArrayDeque<>();
        dq.push(1); dq.addLast(2); dq.offerFirst(0);
        System.out.println(dq + " " + dq.peekLast());
        List<Integer> nums = IntStream.range(0, 20).boxed().collect(Collectors.toList());
        java.util.Collections.shuffle(nums, new Random(7));
        System.out.println(nums);
        nums.sort(null);
        System.out.println(nums.subList(3, 8) + " " + java.util.Collections.max(nums) + " " + java.util.Collections.frequency(nums, 3));
        Set<String> hs = new HashSet<>(List.of("b", "a", "c"));
        Set<String> ts = new TreeSet<>(java.util.Collections.reverseOrder());
        ts.addAll(hs);
        System.out.println(hs + " " + ts + " " + EnumSet.allOf(Thread.State.class));
        Iterator<Integer> it = new ArrayList<>(List.of(1, 2, 3, 4)).iterator();
        int sum = 0;
        while (it.hasNext()) { int v = it.next(); if (v % 2 == 0) sum += v; }
        System.out.println(sum);
        List<String> ll = new LinkedList<>(List.of("x", "y"));
        ll.add(1, "m");
        ListIterator<String> li = ll.listIterator();
        while (li.hasNext()) { String v = li.next(); if (v.equals("m")) li.set("M"); }
        System.out.println(ll + " " + ll.reversed());
        try {
            List<Integer> bad = new ArrayList<>(List.of(1, 2, 3));
            for (Integer x : bad) if (x == 2) bad.remove(x);
        } catch (ConcurrentModificationException e) {
            System.out.println("CME");
        }
        Map<Boolean, List<Integer>> parts = IntStream.rangeClosed(1, 10).boxed().collect(Collectors.partitioningBy(x -> x % 3 == 0));
        System.out.println(parts);
        System.out.println(Stream.iterate(1, x -> x * 2).limit(10).map(String::valueOf).collect(Collectors.joining("+")));
        System.out.println(IntStream.of(3, 1, 2).sorted().boxed().toList() + " " + Stream.of(1, 2, 3, 4).reduce(0, Integer::sum) + " " + DoubleStream.of(1, 2, 3).average().getAsDouble());
        Object[] objs = {1, "two", 3.0, 'c', null};
        System.out.println(Arrays.asList(objs) + " " + Objects.hash(objs) + " " + List.of(1, 2).equals(Arrays.asList(1, 2)));
        BitSet bits = new BitSet();
        bits.set(1); bits.set(10); bits.set(64);
        System.out.println(bits + " " + bits.cardinality() + " " + new StringJoiner(", ", "{", "}").add("a").add("b"));
        var map = new TreeMap<String, List<Integer>>();
        map.computeIfAbsent("k", k -> new ArrayList<>()).add(1);
        map.computeIfAbsent("k", k -> new ArrayList<>()).add(2);
        System.out.println(map + " " + Optional.ofNullable(null).orElse("empty") + " " + Optional.of(5).map(x -> x * 2).get());
    }
}
