/**
 * Hidden behavioral oracle for nestjs/nest issue #4873.
 *
 * Source repository: https://github.com/nestjs/nest (MIT)
 * Historical issue: https://github.com/nestjs/nest/issues/4873
 *
 * This file is copied into a disposable checkout only during evaluation. It
 * deliberately verifies public dependency-injection behavior and does not
 * prescribe the synchronization mechanism used by the implementation.
 */
import { Global, Inject, Injectable, Module, Scope } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';

const globals = Array.from({ length: 12 }, (_, index) => {
  @Global()
  @Module({})
  class EmptyGlobalModule {}

  Object.defineProperty(EmptyGlobalModule, 'name', {
    value: `ArgusGlobalModule${index + 1}`,
  });
  return EmptyGlobalModule;
});
@Injectable()
class TransientDependency {}

@Injectable()
class RequestDependency {}

@Injectable()
class Dependant {
  constructor(
    private readonly transientDependency: TransientDependency,
    @Inject(RequestDependency)
    private readonly requestDependency: RequestDependency,
  ) {}

  verify(): void {
    expect(this.transientDependency).to.be.instanceOf(TransientDependency);
    expect(this.requestDependency).to.be.instanceOf(RequestDependency);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: TransientDependency,
      scope: Scope.TRANSIENT,
      useClass: TransientDependency,
    },
    {
      provide: Dependant,
      scope: Scope.DEFAULT,
      useClass: Dependant,
    },
  ],
})
class GlobalConsumerModule {}

@Global()
@Module({
  providers: [
    {
      provide: RequestDependency,
      scope: Scope.REQUEST,
      useFactory: () => new RequestDependency(),
    },
  ],
  exports: [RequestDependency],
})
class GlobalRequestProviderModule {}

@Module({
  imports: [
    ...globals,
    GlobalConsumerModule,
    GlobalRequestProviderModule,
  ],
})
class AppModule {}

describe('Argus oracle: concurrent global dependency resolution', () => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    it(`resolves complete cross-module dependencies (attempt ${attempt})`, async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      const dependant = await moduleRef.resolve(Dependant);
      dependant.verify();
      await moduleRef.close();
    });
  }
});
