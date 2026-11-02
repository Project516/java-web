import java.math.BigInteger;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.interfaces.RSAPrivateCrtKey;
import java.util.HexFormat;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

// SHA digests, AES and BigInteger arithmetic, at sizes that reach their intrinsics.
public class CryptoMath {
  static final HexFormat HEX = HexFormat.of();

  public static void main(String[] args) throws Exception {
    byte[] data = new byte[1000];
    for (int i = 0; i < data.length; i++) data[i] = (byte) (i * 31 + 7);
    for (String alg : new String[] {"SHA-1", "SHA-224", "SHA-256", "SHA-384", "SHA-512", "SHA-512/256", "MD5"}) {
      MessageDigest md = MessageDigest.getInstance(alg);
      for (int len : new int[] {0, 1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 1000}) {
        md.update(data, 0, len);
        System.out.println(alg + " " + len + " " + HEX.formatHex(md.digest()));
      }
      // many blocks at once, from an offset
      md.update(data, 3, 997);
      System.out.println(alg + " offset " + HEX.formatHex(md.digest()));
    }
    Mac mac = Mac.getInstance("HmacSHA512");
    mac.init(new SecretKeySpec(data, 0, 40, "HmacSHA512"));
    System.out.println("hmac " + HEX.formatHex(mac.doFinal(data)));

    for (int keyLen : new int[] {16, 24, 32}) {
      SecretKeySpec key = new SecretKeySpec(data, keyLen, keyLen, "AES");
      IvParameterSpec iv = new IvParameterSpec(data, 100, 16);
      for (String mode : new String[] {"AES/ECB/NoPadding", "AES/CBC/PKCS5Padding", "AES/CTR/NoPadding"}) {
        Cipher c = Cipher.getInstance(mode);
        c.init(Cipher.ENCRYPT_MODE, key, mode.contains("ECB") ? null : iv);
        byte[] enc = c.doFinal(data, 5, 160);
        c.init(Cipher.DECRYPT_MODE, key, mode.contains("ECB") ? null : iv);
        boolean back = Arrays.equals(c.doFinal(enc), Arrays.copyOfRange(data, 5, 165));
        System.out.println(mode + " " + keyLen + " " + HEX.formatHex(MessageDigest.getInstance("SHA-256").digest(enc), 0, 8) + " " + back);
      }
      // in place, in and out overlapping
      Cipher c = Cipher.getInstance("AES/ECB/NoPadding");
      c.init(Cipher.ENCRYPT_MODE, key);
      byte[] buf = Arrays.copyOf(data, 64);
      c.doFinal(buf, 0, 48, buf, 16);
      System.out.println("in place " + keyLen + " " + HEX.formatHex(buf, 16, 40));
    }

    SecureRandom rnd = SecureRandom.getInstance("SHA1PRNG");
    rnd.setSeed(42);
    for (int bits : new int[] {31, 64, 100, 512, 1024, 2048, 3000, 4100}) {
      BigInteger a = new BigInteger(bits, rnd), b = new BigInteger(bits - 7, rnd).negate();
      BigInteger m = new BigInteger(bits, rnd).setBit(0).setBit(bits - 1);
      System.out.println(bits + " mul " + hash(a.multiply(b)) + " sq " + hash(a.multiply(a)) + " sq2 " + hash(b.pow(2))
          + " mod " + hash(a.modPow(b.negate(), m)) + " even " + hash(a.modPow(b.negate(), m.clearBit(0)))
          + " small " + a.multiply(BigInteger.valueOf(1234567)).mod(m).bitLength());
    }
    KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
    SecureRandom keyRnd = SecureRandom.getInstance("SHA1PRNG");
    keyRnd.setSeed(7);
    kpg.initialize(2048, keyRnd);
    RSAPrivateCrtKey k = (RSAPrivateCrtKey) kpg.generateKeyPair().getPrivate();
    System.out.println("rsa " + hash(k.getModulus()) + " " + hash(k.getPrivateExponent()));
    System.out.println("prime " + BigInteger.probablePrime(512, rnd).bitLength() + " " + new BigInteger("1000000007").isProbablePrime(50));
  }

  static String hash(BigInteger x) throws Exception {
    return HEX.formatHex(MessageDigest.getInstance("SHA-256").digest(x.toByteArray()), 0, 6);
  }
}
