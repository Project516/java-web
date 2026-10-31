void main() {
    IO.println("Hello from Java " + Runtime.version().feature() + " in the browser!");
    var langs = java.util.List.of("Java", "Kotlin", "Scala");
    langs.stream().map(s -> s + " runs on the JVM").forEach(IO::println);
}
