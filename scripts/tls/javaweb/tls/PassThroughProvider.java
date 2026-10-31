package javaweb.tls;

import java.security.Provider;
import java.util.List;

/**
 * The SSLContexts of a VM whose HTTPS goes through the browser. Java sends
 * plain HTTP into a proxy tunnel and the browser's fetch does the TLS, so
 * these contexts encrypt and verify nothing themselves. The keys, trust
 * managers and hostname checks a program passes in have no effect.
 */
public final class PassThroughProvider extends Provider {
    public PassThroughProvider() {
        super("JavaWebTLS", "1.0", "TLS done by the browser through the proxy");
        for (String algorithm : List.of("Default", "TLS", "TLSv1.3", "TLSv1.2", "TLSv1.1", "TLSv1", "SSL")) {
            // newInstance is overridden because the package is not exported for reflection
            putService(new Service(this, "SSLContext", algorithm, PassThroughContext.class.getName(), null, null) {
                @Override
                public Object newInstance(Object parameter) {
                    return new PassThroughContext();
                }
            });
        }
    }
}
