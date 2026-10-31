import java.nio.file.*;
import java.rmi.MarshalledObject;
import java.sql.Timestamp;
import java.util.*;
import javax.crypto.spec.SecretKeySpec;
import javax.naming.ldap.LdapName;
import javax.script.ScriptEngineManager;
import javax.security.sasl.Sasl;
import javax.security.sasl.SaslClient;
import javax.sql.rowset.CachedRowSet;
import javax.sql.rowset.RowSetProvider;
import javax.transaction.xa.XAException;
import javax.xml.crypto.dsig.*;
import javax.xml.crypto.dsig.dom.DOMSignContext;
import javax.xml.crypto.dsig.dom.DOMValidateContext;
import javax.xml.crypto.dsig.spec.C14NMethodParameterSpec;
import javax.xml.crypto.dsig.spec.TransformParameterSpec;
import javax.xml.parsers.DocumentBuilderFactory;
import org.ietf.jgss.Oid;
import org.w3c.dom.Document;

// Touches each module the image carries beyond java.base, java.desktop and javac.
public class SeModules {
    public static void main(String[] args) throws Exception {
        System.out.println("sql " + Timestamp.valueOf("2026-10-27 12:34:56.789").getTime() + " " + java.sql.Types.VARCHAR);

        CachedRowSet rows = RowSetProvider.newFactory().createCachedRowSet();
        System.out.println("rowset " + rows.size() + " " + rows.getClass().getSimpleName());

        LdapName name = new LdapName("CN=Ada,OU=Devices,DC=example,DC=org");
        System.out.println("naming " + name.size() + " " + name.getRdn(name.size() - 1).getValue());

        System.out.println("scripting " + new ScriptEngineManager().getEngineFactories().size());

        System.out.println("rmi " + new MarshalledObject<>("marshalled").get());

        System.out.println("xa " + new XAException(XAException.XA_RBROLLBACK).errorCode);

        System.out.println("jgss " + new Oid("1.2.840.113554.1.2.2"));

        SaslClient sasl = Sasl.createSaslClient(new String[] {"PLAIN"}, "authz", "ldap", "example.org", null,
            callbacks -> {
                for (var c : callbacks) {
                    if (c instanceof javax.security.auth.callback.NameCallback n) n.setName("ada");
                    if (c instanceof javax.security.auth.callback.PasswordCallback p) p.setPassword("pw".toCharArray());
                }
            });
        System.out.println("sasl " + sasl.getMechanismName() + " " + new String(sasl.evaluateChallenge(new byte[0])).replace('\0', '|'));

        signXml();

        Path zip = Files.createTempFile("se-modules", ".zip");
        Files.delete(zip);
        try (FileSystem fs = FileSystems.newFileSystem(zip, Map.of("create", "true"))) {
            Files.writeString(fs.getPath("/hello.txt"), "zipped text");
        }
        try (FileSystem fs = FileSystems.newFileSystem(zip)) {
            System.out.println("zipfs " + Files.readString(fs.getPath("/hello.txt")));
        }
        Files.delete(zip);

        var jar = java.util.spi.ToolProvider.findFirst("jar").orElseThrow();
        Path dir = Files.createTempDirectory("se-modules");
        Files.writeString(dir.resolve("a.txt"), "a");
        Path file = dir.resolve("t.jar");
        jar.run(System.out, System.err, "--create", "--no-manifest", "--file", file.toString(), "-C", dir.toString(), "a.txt");
        var listing = new java.io.ByteArrayOutputStream();
        jar.run(new java.io.PrintStream(listing), System.err, "--list", "--file", file.toString());
        System.out.println("jartool " + listing.toString().trim());
        Files.delete(file);
        Files.delete(dir.resolve("a.txt"));
        Files.delete(dir);
    }

    static void signXml() throws Exception {
        var dbf = DocumentBuilderFactory.newInstance();
        dbf.setNamespaceAware(true);
        Document doc = dbf.newDocumentBuilder().newDocument();
        doc.appendChild(doc.createElement("device")).setTextContent("ada");

        XMLSignatureFactory f = XMLSignatureFactory.getInstance("DOM");
        Reference ref = f.newReference("", f.newDigestMethod(DigestMethod.SHA256, null),
            List.of(f.newTransform(Transform.ENVELOPED, (TransformParameterSpec) null)), null, null);
        SignedInfo si = f.newSignedInfo(
            f.newCanonicalizationMethod(CanonicalizationMethod.EXCLUSIVE, (C14NMethodParameterSpec) null),
            f.newSignatureMethod(SignatureMethod.HMAC_SHA256, null), List.of(ref));
        var key = new SecretKeySpec("0123456789abcdef".getBytes(), "HmacSHA256");
        f.newXMLSignature(si, null).sign(new DOMSignContext(key, doc.getDocumentElement()));

        var sig = doc.getElementsByTagNameNS(XMLSignature.XMLNS, "SignatureValue").item(0).getTextContent();
        var check = new DOMValidateContext(key, doc.getElementsByTagNameNS(XMLSignature.XMLNS, "Signature").item(0));
        System.out.println("xmldsig " + sig + " " + f.unmarshalXMLSignature(check).validate(check));
    }
}
