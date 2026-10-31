import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;

public class HostName {
    public static void main(String[] args) throws Exception {
        InetAddress me = InetAddress.getLocalHost();
        System.out.println(me.getHostName() + " " + me.getHostAddress());
        System.out.println(NetworkInterface.getByName("lo") != null);
        try (ServerSocket server = new ServerSocket(0, 50, me); Socket c = new Socket(me, server.getLocalPort())) {
            System.out.println(server.accept().isConnected() + " " + c.isConnected());
        }
    }
}
