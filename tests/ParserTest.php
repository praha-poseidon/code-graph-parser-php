<?php

declare(strict_types=1);

namespace Poseidon\CodeGraphParserPhp\Tests;

use PHPUnit\Framework\TestCase;
use Poseidon\CodeGraphParserPhp\Parser;

final class ParserTest extends TestCase
{
    public function testBuildsNativePhpGraphAndResolvesStaticBindings(): void
    {
        $root = $this->fixture(<<<'PHP'
<?php
namespace App\Service;

function helper(): void {}

final class UserController
{
    public static function store(): void
    {
        helper();
        self::validate();
    }

    private static function validate(): void {}
}
PHP);

        $delta = (new Parser())->parse(['projectRoot' => $root, 'projectName' => 'native-php']);
        $functionIds = array_column($delta['functions'], 'id');
        self::assertContains('fn:App\Service\helper()', $functionIds);
        self::assertContains('fn:App\Service\UserController::store()', $functionIds);
        self::assertContains('fn:App\Service\UserController::validate()', $functionIds);

        $calls = array_values(array_filter($delta['relationships'], static fn (array $item): bool => $item['relationshipType'] === 'CALLS'));
        self::assertContains('fn:App\Service\helper()', array_column($calls, 'toNodeId'));
        self::assertContains('fn:App\Service\UserController::validate()', array_column($calls, 'toNodeId'));
        self::assertNotContains('UNIT_TO_UNIT', array_column($delta['relationships'], 'relationshipType'));
        self::assertContains('php', array_unique(array_column($delta['functions'], 'language')));
    }

    public function testEndpointExtractionUsesOnlyCallerRules(): void
    {
        $root = $this->fixture(<<<'PHP'
<?php
namespace App;
final class UserController {
    public static function store(): void {}
    public static function routes(): void {
        Route::post('/users/{id}', [UserController::class, 'store']);
    }
}
PHP);
        $request = ['projectRoot' => $root, 'projectName' => 'native-php'];
        self::assertCount(0, (new Parser())->parse($request)['endpoints']);

        $request['ruleTexts'] = [<<<'SER'
rule "Caller route"
fact http_route
find call post
when call owner Route
let method =
  from call take method
let path =
  from argument[0] take value
let handler =
  from handler take reference
build {
  endpointType: "HTTP"
  direction: "inbound"
  method: method | normalize upper
  path: path | normalize httpPath
  handler: handler
}
SER];
        $delta = (new Parser())->parse($request);
        self::assertCount(1, $delta['endpoints']);
        self::assertSame('HTTP:POST:/users/{param}', $delta['endpoints'][0]['matchIdentity']);
        self::assertContains('ENDPOINT_TO_FUNCTION', array_column($delta['relationships'], 'relationshipType'));
    }

    public function testLoadsProjectDefinitionsButScansOnlyRequestedFiles(): void
    {
        $root = sys_get_temp_dir() . '/code-graph-parser-php-closure-' . bin2hex(random_bytes(5));
        mkdir($root);
        file_put_contents($root . '/A.php', "<?php\nnamespace App;\nfunction run(): void { helper(); }\n");
        file_put_contents($root . '/B.php', "<?php\nnamespace App;\nfunction helper(): void {}\n");

        $delta = (new Parser())->parse([
            'projectRoot' => $root,
            'projectName' => 'native-php',
            'sourceFiles' => [$root . '/A.php'],
        ]);
        self::assertNotContains('fn:App\helper()', array_column($delta['functions'], 'id'));
        $calls = array_values(array_filter($delta['relationships'], static fn (array $item): bool => $item['relationshipType'] === 'CALLS'));
        self::assertContains('fn:App\helper()', array_column($calls, 'toNodeId'));
        self::assertNotContains('fn:<unresolved>::App\helper()', array_column($delta['functions'], 'id'));
    }

    public function testDeduplicatesRepeatedRelationshipIdentity(): void
    {
        $root = $this->fixture("<?php\nnamespace App;\nfunction helper(): void {}\nfunction run(): void { helper(); helper(); }\n");
        $delta = (new Parser())->parse(['projectRoot' => $root, 'projectName' => 'native-php']);
        $calls = array_values(array_filter($delta['relationships'], static fn (array $item): bool => $item['relationshipType'] === 'CALLS'
            && $item['fromNodeId'] === 'fn:App\run()'
            && $item['toNodeId'] === 'fn:App\helper()'));
        self::assertCount(1, $calls);
    }

    public function testBindsDeclaredPropertyParameterAndLocalReceiverTypes(): void
    {
        $root = $this->fixture(<<<'PHP'
<?php
namespace App;
final class Worker { public function work(): void {} }
final class Service {
    public function __construct(private Worker $worker) {}
    public function run(Worker $parameter): void {
        $local = new Worker();
        $this->worker->work();
        $parameter->work();
        $local->work();
    }
}
PHP);
        $delta = (new Parser())->parse(['projectRoot' => $root, 'projectName' => 'native-php']);
        $calls = array_values(array_filter($delta['relationships'], static fn (array $item): bool => $item['relationshipType'] === 'CALLS'
            && $item['fromNodeId'] === 'fn:App\Service::run()'
            && $item['toNodeId'] === 'fn:App\Worker::work()'));
        self::assertCount(1, $calls);
        self::assertNotContains('fn:<unresolved>::<dynamic>::work()', array_column($delta['functions'], 'id'));
    }

    public function testUsesStaticallyAssignedClosureAsCallSource(): void
    {
        $root = $this->fixture("<?php\nnamespace App;\nfunction helper(): void {}\n\$callback = function (): void { helper(); };\n");
        $delta = (new Parser())->parse(['projectRoot' => $root, 'projectName' => 'native-php']);
        $closureId = 'fn:App\callback()';
        self::assertNotSame('', $closureId);
        self::assertContains($closureId, array_column($delta['functions'], 'id'));
        $calls = array_values(array_filter($delta['relationships'], static fn (array $item): bool => $item['relationshipType'] === 'CALLS'));
        self::assertContains($closureId, array_column($calls, 'fromNodeId'));
        self::assertContains('fn:App\helper()', array_column($calls, 'toNodeId'));
    }

    public function testEmitsExactInheritanceImplementationAndOverrideRelationships(): void
    {
        $root = $this->fixture(<<<'PHP'
<?php
namespace App;
interface Gateway { public function send(string $value): string; }
interface ChildGateway extends Gateway { public function receive(): string; }
abstract class Base {
    public function run(): void {}
    private function hidden(): void {}
}
class Service extends Base implements ChildGateway {
    public function run(): void {}
    public function send(string $value): string { return $value; }
    public function receive(): string { return 'ok'; }
    public function hidden(): void {}
}
class Unrelated { public function send(string $value): string { return $value; } }
PHP);
        $delta = (new Parser())->parse(['projectRoot' => $root, 'projectName' => 'native-php']);
        $relationships = [];
        foreach ($delta['relationships'] as $item) {
            $relationships[$item['fromNodeId'] . '|' . $item['relationshipType'] . '|' . $item['toNodeId']] = $item;
        }
        $expected = [
            'unit:App\ChildGateway|EXTENDS|unit:App\Gateway',
            'unit:App\Service|EXTENDS|unit:App\Base',
            'unit:App\Service|IMPLEMENTS|unit:App\ChildGateway',
            'fn:App\Service::run()|OVERRIDES|fn:App\Base::run()',
            'fn:App\Service::send()|OVERRIDES|fn:App\Gateway::send()',
            'fn:App\Service::receive()|OVERRIDES|fn:App\ChildGateway::receive()',
        ];
        foreach ($expected as $key) {
            self::assertArrayHasKey($key, $relationships);
            [$from, $type, $to] = explode('|', $key);
            self::assertSame('rel:' . sha1("$from|$type|$to"), $relationships[$key]['id']);
        }
        self::assertArrayNotHasKey('fn:App\Service::hidden()|OVERRIDES|fn:App\Base::hidden()', $relationships);
        self::assertArrayNotHasKey('fn:App\Unrelated::send()|OVERRIDES|fn:App\Gateway::send()', $relationships);

        $nodeIds = array_fill_keys(array_merge(
            array_column($delta['packages'], 'id'),
            array_column($delta['units'], 'id'),
            array_column($delta['functions'], 'id'),
            array_column($delta['endpoints'], 'id'),
        ), true);
        foreach ($delta['relationships'] as $relationship) {
            self::assertArrayHasKey($relationship['fromNodeId'], $nodeIds);
            self::assertArrayHasKey($relationship['toNodeId'], $nodeIds);
        }
    }

    public function testExpandsMultipleHttpMethodsIntoDistinctEndpoints(): void
    {
        $root = $this->fixture(<<<'PHP'
<?php
namespace App;
final class Controller {
    #[Route('/save', methods: ['GET', 'POST'])]
    public function save(): void {}
}
PHP);
        $delta = (new Parser())->parse([
            'projectRoot' => $root,
            'projectName' => 'native-php',
            'ruleSources' => [dirname(__DIR__, 2) . '/static-extract-php/examples/conformance/php-endpoints/rules/symfony-route.ser'],
        ]);
        self::assertEqualsCanonicalizing(['HTTP:GET:/save', 'HTTP:POST:/save'], array_column($delta['endpoints'], 'matchIdentity'));
    }

    public function testConfiguredAssignedCallableCreatesInboundEndpointAndOther(): void
    {
        $root = $this->fixture(<<<'PHP'
<?php
namespace App;
final class Handlers {
    public function configure(): void { $handlers = ['save' => fn (): string => 'ok']; }
}
PHP);
        $delta = (new Parser())->parse([
            'projectRoot' => $root,
            'projectName' => 'native-php',
            'ruleTexts' => [<<<'SER'
rule "Configured callable"
fact http_route
find method save
let path =
  from method take value
let handler =
  from method take reference
build {
  endpointType: "HTTP"
  direction: "inbound"
  method: "POST"
  path: path
  handler: handler
  other: "source=caller-ser"
}
dict {
  App.Handlers.save() = /save
}
SER],
        ]);
        self::assertContains('fn:App\Handlers::save()', array_column($delta['functions'], 'id'));
        self::assertCount(1, $delta['endpoints']);
        self::assertSame('source=caller-ser', $delta['endpoints'][0]['other']);
        self::assertSame('endpoint:inbound:HTTP:' . sha1('inbound:HTTP:HTTP:POST:/save'), $delta['endpoints'][0]['id']);
        self::assertSame('config', $delta['endpoints'][0]['parseLevel']);
        self::assertContains('ENDPOINT_TO_FUNCTION', array_column($delta['relationships'], 'relationshipType'));
    }

    public function testStandardEndpointIdentitiesExcludeOtherMetadata(): void
    {
        $root = $this->fixture(<<<'PHP'
<?php
namespace App;
function run(): void {
    $http->get('/health');
    $mq->send('orders');
    $redis->get('user:*');
    $db->query('users');
}
PHP);
        $rules = [];
        foreach ([
            ['HTTP', 'get', 'http', 'path', '/health', 'method: "GET"'],
            ['MQ', 'send', 'mq', 'topic', 'orders', 'operation: "PRODUCE"'],
            ['REDIS', 'get', 'redis', 'keyPattern', 'user:*', 'command: "GET"'],
            ['DB', 'query', 'db', 'tableName', 'users', 'dbOperation: "QUERY"'],
        ] as [$type, $call, $owner, $identityField, $value, $extra]) {
            $rules[] = <<<SER
rule "$type identity"
fact {$owner}_endpoint
find call $call
when call owner $owner
let identity =
  from argument[0] take value
build {
  endpointType: "$type"
  direction: "outbound"
  $extra
  $identityField: identity
  other: "ignored-by-identity"
}
SER;
        }
        $delta = (new Parser())->parse([
            'projectRoot' => $root,
            'projectName' => 'native-php',
            'ruleTexts' => $rules,
        ]);
        $identities = array_column($delta['endpoints'], 'matchIdentity');
        self::assertEqualsCanonicalizing(['HTTP:GET:/health', 'MQ:orders', 'REDIS:user:*', 'DB:users'], $identities);
        foreach ($delta['endpoints'] as $endpoint) {
            self::assertSame('ignored-by-identity', $endpoint['other']);
            self::assertSame('endpoint:outbound:' . $endpoint['endpointType'] . ':' . sha1('outbound:' . $endpoint['endpointType'] . ':' . $endpoint['matchIdentity']), $endpoint['id']);
        }
        self::assertCount(4, array_filter($delta['relationships'], static fn (array $item): bool => $item['relationshipType'] === 'FUNCTION_TO_ENDPOINT'));
    }

    private function fixture(string $source): string
    {
        $root = sys_get_temp_dir() . '/code-graph-parser-php-' . bin2hex(random_bytes(5));
        mkdir($root);
        file_put_contents($root . '/App.php', $source);
        return $root;
    }
}
