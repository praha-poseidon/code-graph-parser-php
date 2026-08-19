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

    public function testUsesSyntheticClosureAsCallSource(): void
    {
        $root = $this->fixture("<?php\nnamespace App;\nfunction helper(): void {}\n\$callback = function (): void { helper(); };\n");
        $delta = (new Parser())->parse(['projectRoot' => $root, 'projectName' => 'native-php']);
        $closureId = array_values(array_filter(array_column($delta['functions'], 'id'), static fn (string $id): bool => str_starts_with($id, 'fn:App@App.php::<closure@4:')))[0] ?? '';
        self::assertNotSame('', $closureId);
        self::assertContains($closureId, array_column($delta['functions'], 'id'));
        $calls = array_values(array_filter($delta['relationships'], static fn (array $item): bool => $item['relationshipType'] === 'CALLS'));
        self::assertContains($closureId, array_column($calls, 'fromNodeId'));
        self::assertContains('fn:App\helper()', array_column($calls, 'toNodeId'));
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

    private function fixture(string $source): string
    {
        $root = sys_get_temp_dir() . '/code-graph-parser-php-' . bin2hex(random_bytes(5));
        mkdir($root);
        file_put_contents($root . '/App.php', $source);
        return $root;
    }
}
