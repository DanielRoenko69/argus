// Reuse the existing local workload credential. No new Gitea token or
// browser-session forwarding. Never replace a differently configured entry.
import com.cloudbees.plugins.credentials.CredentialsScope
import com.cloudbees.plugins.credentials.SystemCredentialsProvider
import com.cloudbees.plugins.credentials.domains.Domain
import com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl

def username = System.getenv('GITEA_CLONE_USERNAME')
def token = System.getenv('GITEA_CLONE_TOKEN')
if (!username || !token) throw new IllegalStateException('Gitea workload credential is missing')
def provider = SystemCredentialsProvider.getInstance()
def id = 'argus-local-gitea-scm'
def matches = provider.credentials.findAll { it.id == id }
if (matches.size() > 1) throw new IllegalStateException('Ambiguous SCM credential')
if (matches) {
    def existing = matches[0]
    if (!(existing instanceof UsernamePasswordCredentialsImpl) ||
        existing.username != username || existing.password.plainText != token) {
        throw new IllegalStateException('Existing SCM credential differs; operator review required')
    }
} else {
    provider.store.addCredentials(Domain.global(), new UsernamePasswordCredentialsImpl(
        CredentialsScope.GLOBAL, id, 'Existing Argus local Gitea workload credential', username, token))
}
