import org.cryptomator.cryptofs.*;
import org.cryptomator.cryptolib.api.*;
import org.cryptomator.cryptolib.common.MasterkeyFileAccess;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;

public class Gen {
  static StringBuilder manifest = new StringBuilder();
  static String hex(byte[] b){ StringBuilder s=new StringBuilder(); for(byte x:b) s.append(String.format("%02x",x)); return s.toString(); }
  static byte[] det(int n, int seed){ byte[] b=new byte[n]; new Random(seed).nextBytes(b); return b; }
  static void put(FileSystem fs, String p, byte[] data) throws Exception {
    Path path = fs.getPath(p);
    if (path.getParent()!=null) Files.createDirectories(path.getParent());
    Files.write(path, data);
    if (manifest.length()>0) manifest.append(",\n");
    manifest.append("  {\"path\":").append(json(p)).append(",\"size\":").append(data.length).append(",\"sha256\":\"")
      .append(hex(MessageDigest.getInstance("SHA-256").digest(data))).append("\"}");
  }
  static String json(String s){ StringBuilder b=new StringBuilder("\""); for(char c: s.toCharArray()){ if(c=='"'||c=='\\') b.append('\\').append(c); else if(c<0x20||c>0x7e) b.append(String.format("\\u%04x",(int)c)); else b.append(c);} return b.append('"').toString(); }

  public static void main(String[] a) throws Exception {
    Path vault = Paths.get(a[0]);
    CryptorProvider.Scheme scheme = CryptorProvider.Scheme.valueOf(a[1]);
    String pw = a[2];
    Files.createDirectories(vault);
    SecureRandom rnd = new SecureRandom();
    Masterkey mk = Masterkey.generate(rnd);
    MasterkeyFileAccess mfa = new MasterkeyFileAccess(new byte[0], rnd);
    mfa.persist(mk, vault.resolve("masterkey.cryptomator"), pw);
    MasterkeyLoader loader = uri -> mfa.load(vault.resolve("masterkey.cryptomator"), pw);
    CryptoFileSystemProperties props = CryptoFileSystemProperties.cryptoFileSystemProperties()
      .withKeyLoader(loader).withCipherCombo(scheme).withShorteningThreshold(220).build();
    CryptoFileSystemProvider.initialize(vault, props, URI.create("masterkeyfile:masterkey.cryptomator"));
    try (FileSystem fs = CryptoFileSystemProvider.newFileSystem(vault, props)) {
      put(fs, "/hello.txt", "Hallo Welt ☺\n".getBytes(StandardCharsets.UTF_8));
      put(fs, "/empty.bin", new byte[0]);
      put(fs, "/exact-chunk.bin", det(32768, 1));
      put(fs, "/multi-chunk.bin", det(32768*3+5, 2));
      put(fs, "/Ünïcödé – 日本語.txt", "unicode".getBytes(StandardCharsets.UTF_8));
      put(fs, "/docs/readme.md", "# Readme\n".getBytes(StandardCharsets.UTF_8));
      put(fs, "/docs/nested/deep/file.bin", det(100000, 3));
      String longName = "l".repeat(200) + ".txt";
      put(fs, "/" + longName, "long file name".getBytes(StandardCharsets.UTF_8));
      String longDir = "D".repeat(210);
      put(fs, "/" + longDir + "/inside.txt", "inside long dir".getBytes(StandardCharsets.UTF_8));
      put(fs, "/sub with space/a.txt", "a".getBytes(StandardCharsets.UTF_8));
    }
    Files.writeString(vault.resolveSibling(vault.getFileName() + ".manifest.json"), "[\n" + manifest + "\n]\n");
  }
}
