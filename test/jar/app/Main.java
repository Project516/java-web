package app;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.*;

public class Main {
    public static void main(String[] args) throws Exception {
        System.out.println("from jar, args " + Arrays.toString(args));
        try (InputStream in = Main.class.getResourceAsStream("/app/data.txt")) {
            String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            System.out.println("resource lines " + text.lines().count() + " last " + text.lines().reduce((a, b) -> b).get());
        }
        System.out.println(new Helper().greet("jar"));
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (GZIPOutputStream gz = new GZIPOutputStream(bos)) {
            gz.write("round trip ".repeat(1000).getBytes(StandardCharsets.UTF_8));
        }
        try (GZIPInputStream gin = new GZIPInputStream(new ByteArrayInputStream(bos.toByteArray()))) {
            System.out.println("gzip " + new String(gin.readAllBytes(), StandardCharsets.UTF_8).length());
        }
        CRC32 crc = new CRC32();
        crc.update("hello".getBytes());
        System.out.println("crc " + Long.toHexString(crc.getValue()));
        System.out.println(Main.class.getPackage().getName() + " " + Main.class.getProtectionDomain().getCodeSource().getLocation().getPath().endsWith("app.jar"));
    }
}
