-- Fase 99D — pré-requisito estrutural da destinação: chaves únicas (id, organization_id) em inventory_items e files, para que as futuras tabelas de destinação referenciem item e
-- comprovante por FK COMPOSTA e o banco rejeite referência a registro de outra organização (mesmo padrão já usado em needs e stock_transactions). id já é a chave primária,
-- então (id, organization_id) é único por construção: nenhuma linha existente pode violar.
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_id_organization_id_key UNIQUE (id, organization_id);
ALTER TABLE files ADD CONSTRAINT files_id_organization_id_key UNIQUE (id, organization_id);
